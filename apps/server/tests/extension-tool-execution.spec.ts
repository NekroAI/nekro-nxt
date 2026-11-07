import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { AssetService, CoreService } from '@nekro-nxt/core'
import type {
  ExtensionJsonValue,
  ExtensionToolDefinition,
  ExtensionToolExecutionContext,
} from '@nekro-nxt/extension-sdk'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { channelImageSubmission, trackToolCallSessions } from '../src/dsh-plugin-images.js'
import { bindExtensionTool, extensionToolContext, extensionToolTimeoutMs } from '../src/extension-tool-context.js'
import { withToolImages, type ToolResultImage } from '../src/extension-tool-images.js'
import { createDynamicTimers } from '../src/extension-host-service.js'
import { wrapDynamicHostSource } from '../src/inbound-dynamic-harness.js'
import { NekroAssetAttachmentStore, parseNekroImageAttachmentId } from '../src/session-image-context.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const temporary = async (prefix: string) => {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

const tool = (overrides: Partial<ExtensionToolDefinition> = {}): ExtensionToolDefinition => ({
  name: 'clip_frames',
  description: '取帧',
  parameters: {},
  output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: '完成' }] },
  execute: (_args, context) => ({ aborted: context.signal.aborted }),
  ...overrides,
})

describe('long-running extension tools', () => {
  it('turns timeoutSeconds into the DSH time limit and checks it', () => {
    expect(extensionToolTimeoutMs(tool(), 14)).toBeUndefined()
    expect(extensionToolTimeoutMs(tool({ timeoutSeconds: 900 }), 14)).toBe(900_000)
    expect(extensionToolTimeoutMs(tool({ timeoutSeconds: 120 }), undefined)).toBe(120_000)
    expect(() => extensionToolTimeoutMs(tool({ timeoutSeconds: 901 }), 14)).toThrow('1 到 900')
    expect(() => extensionToolTimeoutMs(tool({ timeoutSeconds: 1.5 }), 14)).toThrow('1 到 900')
    expect(() => extensionToolTimeoutMs(tool({ timeoutSeconds: 60 }), 13)).toThrow('requires.sdk 为 14')
    expect(bindExtensionTool(tool({ timeoutSeconds: 60 }), { sdk: 14 }).timeoutMs).toBe(60_000)
    expect('timeoutMs' in bindExtensionTool(tool(), { sdk: 13 })).toBe(false)
  })

  it('hands the body the call signal and a progress reporter bound to the call', async () => {
    const reports: unknown[] = []
    let seen: ExtensionToolExecutionContext | undefined
    const bound = bindExtensionTool(
      tool({
        execute: (_args, context) => {
          seen = context
          context.progress({ text: '已处理 3/10 段', fraction: 0.3 })
          return null
        },
      }),
      { sdk: 14, progress: (callId, update) => reports.push([callId, update]) },
    )
    const controller = new AbortController()
    await bound.execute({}, { callId: 'call_1', signal: controller.signal })
    expect(seen?.signal).toBe(controller.signal)
    expect(reports).toEqual([['call_1', { text: '已处理 3/10 段', fraction: 0.3 }]])
    // Verification and other callers without an execution still get a usable context.
    const idle = extensionToolContext(undefined, (callId) => reports.push(callId))
    expect(idle.signal.aborted).toBe(false)
    idle.progress({ text: '忽略' })
    expect(reports).toHaveLength(1)
  })

  it('passes the execution through the tool image wrapper', async () => {
    const controller = new AbortController()
    controller.abort()
    const wrapped = withToolImages(bindExtensionTool(tool(), {}), { plan: () => Promise.resolve([]) })
    expect(await wrapped.execute({}, { callId: 'call_2', signal: controller.signal })).toEqual({ aborted: true })
  })

  it('lets dynamic runs declare time limits and report progress the same way', async () => {
    const defined: Record<string, unknown>[] = []
    const harness = {
      handle: () => undefined,
      defineTool: (options: Record<string, unknown>) => {
        defined.push(options)
        return options
      },
    }
    const source = wrapDynamicHostSource(
      `const clip = harness.defineTool({ name: 'clip', timeoutSeconds: 300, execute: (args, context) => { context.progress({ text: '一半', fraction: 0.5 }); return context.signal.aborted } })
       return { clip, apply() {} }`,
      { inbound: false, hostConfig: {} },
    )
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-type-assertion -- the wrapper is source the DSH sandbox evaluates; its result shape is what the source returns.
    const factory = new Function('harness', `return (async () => {${source}})()`) as (
      value: typeof harness,
    ) => Promise<{ clip: { execute: (args: unknown, exec: unknown) => unknown }; apply: (ctx: unknown) => void }>
    const plugin = await factory(harness)
    expect(defined[0]).toMatchObject({ name: 'clip', timeoutMs: 300_000 })
    expect(defined[0]).not.toHaveProperty('timeoutSeconds')
    const reportToolProgress = vi.fn()
    plugin.apply({
      effect: () => undefined,
      nxt: { reportToolProgress, config: () => ({}), sandboxGlobals: { createTimers: createDynamicTimers } },
    })
    expect(plugin.clip.execute({}, { callId: 'call_3', signal: new AbortController().signal })).toBe(false)
    expect(reportToolProgress).toHaveBeenCalledWith('call_3', { text: '一半', fraction: 0.5 })
    const invalid = wrapDynamicHostSource(
      `harness.defineTool({ name: 'slow', timeoutSeconds: 3600, execute: () => 1 })`,
      {
        inbound: false,
        hostConfig: {},
      },
    )
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-type-assertion -- as above.
    const failing = new Function('harness', `return (async () => {${invalid}})()`) as (
      value: typeof harness,
    ) => Promise<unknown>
    await expect(failing(harness)).rejects.toThrow('1 到 900')
  })

  it('gives dynamic runs Node timers that stop with the run', async () => {
    const source = wrapDynamicHostSource(
      `return {
        later: (fn, ms) => setTimeout(fn, ms),
        cancel: (handle) => clearTimeout(handle),
        every: (fn, ms) => setInterval(fn, ms),
        deadline: (ms) => AbortSignal.timeout(ms),
        either: (signals) => AbortSignal.any(signals),
        apply() {},
      }`,
      { inbound: false, hostConfig: {} },
    )
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-type-assertion -- as above.
    const factory = new Function('harness', `return (async () => {${source}})()`) as (value: unknown) => Promise<{
      later: (fn: () => void, ms: number) => unknown
      cancel: (handle: unknown) => void
      every: (fn: () => void, ms: number) => unknown
      deadline: (ms: number) => AbortSignal
      either: (signals: AbortSignal[]) => AbortSignal
      apply: (ctx: unknown) => void
    }>
    const plugin = await factory({ handle: () => undefined, defineTool: (options: unknown) => options })
    // Before the candidate is mounted there is nothing to hang a timer on.
    expect(() => plugin.later(() => undefined, 1)).toThrow('要等扩展挂载后')
    const stops: (() => void)[] = []
    plugin.apply({
      effect: (execute: () => () => void) => stops.push(execute()),
      nxt: { config: () => ({}), sandboxGlobals: { createTimers: createDynamicTimers, AbortSignal } },
    })
    const fired = vi.fn()
    plugin.later(fired, 5)
    plugin.cancel(plugin.later(fired, 5))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(fired).toHaveBeenCalledTimes(1)
    const deadline = plugin.deadline(5)
    const either = plugin.either([deadline, new AbortController().signal])
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(either.aborted).toBe(true)
    expect(deadline.reason).toMatchObject({ name: 'TimeoutError' })

    // Stopping the candidate clears what it still holds; nothing fires afterwards.
    const late = vi.fn()
    plugin.later(late, 20)
    plugin.every(late, 5)
    const stopped = plugin.deadline(20)
    for (const stop of stops) stop()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(late).not.toHaveBeenCalled()
    expect(stopped.aborted).toBe(false)
    expect(() => plugin.later(late, 1)).toThrow('候选已经停止运行')
  })
})

describe('tool result image detail', () => {
  const pictureTool = (detail?: 'low' | 'high') =>
    tool({
      output: {
        schema: { type: 'json' },
        render: () => [
          { type: 'image', assetId: 'ast_A', ...(detail === undefined ? {} : { detail }) },
          { type: 'image', assetId: 'ast_B', label: '宫格' },
        ],
      },
      execute: (): ExtensionJsonValue => ['ast_A', 'ast_B'],
    })

  it('asks the resolver for the detail each picture wants, low unless it says high', async () => {
    const asked: ToolResultImage[][] = []
    const resolver = {
      plan: (images: readonly ToolResultImage[]) => {
        asked.push([...images])
        return Promise.resolve(images.map(() => ({ state: 'visible' as const })))
      },
    }
    await withToolImages(bindExtensionTool(pictureTool('high'), {}), resolver).execute({})
    await withToolImages(bindExtensionTool(pictureTool(), {}), resolver).execute({})
    expect(asked).toEqual([
      [
        { assetId: 'ast_A', detail: 'high' },
        { assetId: 'ast_B', label: '宫格', detail: 'low' },
      ],
      [
        { assetId: 'ast_A', detail: 'low' },
        { assetId: 'ast_B', label: '宫格', detail: 'low' },
      ],
    ])
  })

  it('sends high-detail pictures at most 2048 px on the long side and low ones at 512', async () => {
    const root = await temporary('nxt-high-detail-')
    const database = await openMigratedCoreDatabase(path.join(root, 'core.sqlite'))
    try {
      const repository = new SqliteCoreRepository(database)
      const assetService = new AssetService(repository, path.join(root, 'assets'))
      const data = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: '#357' } })
        .png()
        .toBuffer()
      const { asset } = await assetService.prepare({ bytes: data })
      const store = new NekroAssetAttachmentStore(new Context(), {
        assets: repository,
        assetService,
        requestImageRoot: path.join(root, 'request-images'),
      })
      const target = { width: 4096, height: 4096, maxBytes: 16 * 1024 * 1024 }
      const high = await store.refForHighDetail(asset)
      expect(parseNekroImageAttachmentId(high.attachmentId)).toEqual({ assetId: asset.id, detail: 'high' })
      const highRequest = await store.readImageRequest(high, target)
      expect([highRequest.width, highRequest.height]).toEqual([2048, 1024])
      const lowRequest = await store.readImageRequest(await store.refForAsset(asset, undefined, 'low'), target)
      expect(Math.max(lowRequest.width, lowRequest.height)).toBe(512)
      const autoRequest = await store.readImageRequest(await store.refForAsset(asset), target)
      expect(autoRequest.width).toBe(3000)
    } finally {
      database.close()
    }
  })
})

describe('DSH plugin image submission', () => {
  it('stores a submitted picture in the channel of the running tool call', async () => {
    const root = await temporary('nxt-plugin-images-')
    const database = await openMigratedCoreDatabase(path.join(root, 'core.sqlite'))
    try {
      const repository = new SqliteCoreRepository(database)
      const assetService = new AssetService(repository, path.join(root, 'assets'))
      const store = new NekroAssetAttachmentStore(new Context(), {
        assets: repository,
        assetService,
        requestImageRoot: path.join(root, 'request-images'),
      })
      const core = new CoreService(repository)
      const connection = core.createConnection({ adapterKey: 'fixture-alpha', config: {} })
      const channelId = core.createChannel({
        connectionId: connection.id,
        platformChannelId: 'room-images',
        kind: 'group',
      }).id
      const submission = channelImageSubmission({
        store: () => store,
        channelOf: (sessionId) => (sessionId === 'nxt-session' ? channelId : undefined),
        assets: repository,
        assetService,
      })
      let wrapper: ((exec: { agent?: { id: string } }, next: () => Promise<unknown>) => Promise<unknown>) | undefined
      // A Context stand-in that records the one listener the function registers; only `on` is used.
      const recorder = {
        on: (_name: string, listener: typeof wrapper) => {
          wrapper = listener
          return () => undefined
        },
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- see above.
      trackToolCallSessions(recorder as unknown as Context)
      const image: SaveImageAttachment = {
        data: new Uint8Array(
          await sharp({ create: { width: 20, height: 10, channels: 3, background: '#a53' } })
            .png()
            .toBuffer(),
        ),
        mediaType: 'image/png',
        name: 'chart.png',
      }
      await expect(submission.saveImage(image)).rejects.toThrow('only from a tool call')
      await expect(wrapper!({ agent: { id: 'other-session' } }, () => submission.saveImage(image))).rejects.toThrow(
        'only from a tool call',
      )
      let saved: Awaited<ReturnType<typeof submission.saveImage>> | undefined
      await wrapper!({ agent: { id: 'nxt-session' } }, async () => {
        await Promise.resolve()
        saved = await submission.saveImage(image)
      })
      const ref = saved!
      const decoded = parseNekroImageAttachmentId(ref.attachmentId)
      expect(ref).toMatchObject({ width: 20, height: 10, name: 'chart.png', mediaType: 'image/png' })
      expect(decoded).toMatchObject({ detail: 'auto' })
      expect(repository.canAccessAsset(decoded!.assetId, channelId)).toBe(true)
      expect((await store.readImage(ref)).data.byteLength).toBe(image.data.byteLength)
    } finally {
      database.close()
    }
  })
})
