import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtensionIdSchema, type ExtensionCapabilities } from '@nekro-nxt/contracts'
import { AssetService, CoreService } from '@nekro-nxt/core'
import { localExtensions, openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { CommandProfileError, CommandProfiles, FFMPEG_PROFILE, FFPROBE_PROFILE } from '../src/command-profiles.js'
import { ConfinedProgramRunner, createProgramSandbox } from '../src/confined-program.js'
import { ExtensionFileStore } from '../src/extension-files.js'
import {
  createHostLayerNxt,
  createNxtHostService,
  type NxtServiceBackends,
  type NxtServiceBinding,
} from '../src/extension-host-service.js'
import { ExtensionLibrary, sqliteLibraryRegistry } from '../src/extension-library.js'
import { commonMediaDirectories, findSystemMediaPrograms } from '../src/media-ffmpeg.js'
import { MediaError, MediaToolkit } from '../src/media-toolkit.js'
import { SpeechUnavailableError } from '../src/speech-service.js'
import { verificationMediaBackends } from '../src/verification-media-backends.js'
import { unusedNxtBackends } from './fixtures/unused-nxt-backends.js'

const directories: string[] = []
const stores: ExtensionFileStore[] = []
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.dispose()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const temporary = async (prefix: string): Promise<string> => {
  const directory = realpathSync(await mkdtemp(path.join(tmpdir(), prefix)))
  directories.push(directory)
  return directory
}

const extensionId = ExtensionIdSchema.parse('ext_MEDIAFIXTURE0000000000000')
const MiB = 1024 * 1024
const filesDeclared = { files: { tempQuotaBytes: MiB, cacheQuotaBytes: MiB } } satisfies ExtensionCapabilities

const transcript = (text: string) => ({
  text,
  segments: [{ start: 0, end: 1.5, text }],
  durationSeconds: 1.5,
  provider: { id: 'fixture-provider', title: '示例识别' },
  model: 'fixture-model',
})

const setup = async (overrides: Partial<Pick<NxtServiceBackends, 'media' | 'commands' | 'speech'>> = {}) => {
  const directory = await temporary('nekro-nxt-media-services-')
  const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
  const repository = new SqliteCoreRepository(database)
  database.db
    .insert(localExtensions)
    .values({ id: extensionId, provides: ['agent'], slug: 'media', displayName: '示例', description: '', createdAt: 1 })
    .run()
  let sequence = 0
  const core = new CoreService(repository, { now: () => 5, nextUlid: () => `C${String(++sequence).padStart(25, '0')}` })
  const connection = core.createConnection({ adapterKey: 'fixture-alpha', config: {} })
  const roomA = core.createChannel({ connectionId: connection.id, platformChannelId: 'room-a', kind: 'group' })
  const roomB = core.createChannel({ connectionId: connection.id, platformChannelId: 'room-b', kind: 'group' })
  const assetService = new AssetService(repository, path.join(directory, 'assets'), {
    now: () => 10,
    nextUlid: () => `A${String(++sequence).padStart(25, '0')}`,
  })
  const library = new ExtensionLibrary({
    registry: sqliteLibraryRegistry(repository.extensionLibrary),
    assets: repository,
    assetService,
    now: () => 100,
  })
  const filesRoot = path.join(directory, 'extension-files')
  const files = new ExtensionFileStore({
    root: filesRoot,
    blobPath: (contentDigest) => assetService.blobPath({ contentDigest }),
  })
  stores.push(files)
  const backends: NxtServiceBackends = { ...unusedNxtBackends(), library, files, ...overrides }
  const binding = (
    channelId: string,
    capabilities: ExtensionCapabilities | undefined,
    mode: NxtServiceBinding['mode'] = 'activation',
  ): NxtServiceBinding => ({
    mode,
    agentId: 'agt_FIXTURE',
    ownerKey: extensionId,
    displayName: '示例',
    channelId,
    capabilities: () => capabilities,
    config: () => ({}),
    declaredSecrets: () => ({ config: [], hostConfig: [] }),
  })
  const inChannel = async (content: Uint8Array, channelId: typeof roomA.id) => {
    const prepared = await assetService.prepare({ bytes: content })
    repository.grantAssetAccess({ assetId: prepared.asset.id, channelId, source: 'agent-tool', grantedAt: 6 })
    return prepared.asset
  }
  /** Work folders left behind under the owner's files; every call removes its own. */
  const workFolders = async () => {
    const owners = await readdir(filesRoot).catch(() => [])
    const names = await Promise.all(owners.map((owner) => readdir(path.join(filesRoot, owner))))
    return names.flat().filter((name) => name.startsWith('work-'))
  }
  return { backends, binding, roomA, roomB, inChannel, files, workFolders, root: directory }
}

describe('nxt.media', () => {
  const fakeMedia = (): NxtServiceBackends['media'] => ({
    probe: vi.fn(() => Promise.resolve({ durationSeconds: 2, format: 'mov', streams: [] })),
    frames: vi.fn(async (_input: string, _options: unknown, outDir: string) => {
      const frames = []
      for (const [index, time] of [0.5, 1.5].entries()) {
        const file = path.join(outDir, `frame-${index}.jpg`)
        await writeFile(file, Buffer.alloc(600 * 1024, index))
        frames.push({ time, path: file, width: 160, height: 90 })
      }
      return frames
    }),
    audio: vi.fn(async (_input: string, options: { readonly format: 'wav' }, outPath: string) => {
      await writeFile(outPath, 'RIFF')
      return { path: outPath, byteSize: 4, format: options.format, sampleRate: 16000, channels: 1 }
    }),
    convert: vi.fn(async (_input: string, options: { readonly format: 'silk' }, outPath: string) => {
      await writeFile(outPath, 'SILK')
      return { path: outPath, byteSize: 4, format: options.format }
    }),
  })

  it('reads channel Assets and work files and returns outputs as work files', async () => {
    const media = fakeMedia()
    const { backends, binding, roomA, inChannel, workFolders } = await setup({ media })
    const asset = await inChannel(new TextEncoder().encode('示例视频'), roomA.id)
    const nxt = createNxtHostService(
      binding(roomA.id, { media: true, files: { tempQuotaBytes: 4 * MiB, cacheQuotaBytes: MiB } }),
      backends,
    )
    expect(await nxt.media.probe({ assetId: asset.id })).toMatchObject({ durationSeconds: 2 })
    const frames = await nxt.media.frames({ assetId: asset.id }, { at: [0.5, 1.5], format: 'jpeg' })
    expect(frames.map(({ time, width, height }) => [time, width, height])).toEqual([
      [0.5, 160, 90],
      [1.5, 160, 90],
    ])
    expect(await nxt.files.stat(frames[0]!.fileId)).toMatchObject({ mediaType: 'image/jpeg', kind: 'temp' })
    const voice = await nxt.files.write({ base64: Buffer.from('mp3').toString('base64'), name: 'reply.mp3' })
    expect(await nxt.media.convert({ fileId: voice.fileId }, { format: 'silk' })).toMatchObject({
      byteSize: 4,
      format: 'silk',
    })
    const audio = await nxt.media.audio({ fileId: voice.fileId }, { format: 'wav', sampleRate: 16000 })
    expect(audio).toMatchObject({ format: 'wav', sampleRate: 16000, channels: 1 })
    expect(Buffer.from((await nxt.files.read(audio.fileId)).base64, 'base64').toString()).toBe('RIFF')
    expect(await workFolders()).toEqual([])
  })

  it('needs the declaration, the files declaration for outputs and a visible input', async () => {
    const { backends, binding, roomA, roomB, inChannel } = await setup({ media: fakeMedia() })
    const asset = await inChannel(new TextEncoder().encode('别处的视频'), roomB.id)
    const undeclared = createNxtHostService(binding(roomA.id, filesDeclared), backends)
    await expect(undeclared.media.probe({ assetId: asset.id })).rejects.toThrow('media（媒体处理）')
    const withoutFiles = createNxtHostService(binding(roomB.id, { media: true }), backends)
    await expect(withoutFiles.media.frames({ assetId: asset.id }, { format: 'png' })).rejects.toThrow(
      'files（工作文件）',
    )
    const nxt = createNxtHostService(binding(roomA.id, { media: true, ...filesDeclared }), backends)
    await expect(nxt.media.probe({ assetId: asset.id })).rejects.toThrow('不在当前频道或扩展资源库里')
    await expect(nxt.media.probe({ fileId: 'file_00000000000000000000000000000000' })).rejects.toThrow('找不到文件')
    await expect(nxt.media.probe({ assetId: asset.id, fileId: 'file_0' })).rejects.toThrow('{ assetId } 或 { fileId }')
  })

  it('counts outputs against the temp quota and keeps nothing of a call that does not fit', async () => {
    const { backends, binding, roomA, inChannel, files, workFolders } = await setup({ media: fakeMedia() })
    const asset = await inChannel(new TextEncoder().encode('示例视频'), roomA.id)
    // Two frames of 600 KiB do not fit into 1 MiB.
    const nxt = createNxtHostService(binding(roomA.id, { media: true, ...filesDeclared }), backends)
    await expect(nxt.media.frames({ assetId: asset.id }, { format: 'jpeg' })).rejects.toThrow('临时文件已满')
    expect(files.usage(extensionId).tempBytes).toBe(0)
    expect(await workFolders()).toEqual([])
  })

  it('passes the add-on message on while 媒体处理 is unavailable', async () => {
    const unavailable = new MediaError('media-unavailable', '媒体处理不可用，请管理员到「设置 → 附加功能」安装。')
    const { backends, binding, roomA, inChannel } = await setup({
      media: { ...fakeMedia(), probe: () => Promise.reject(unavailable) },
    })
    const asset = await inChannel(new TextEncoder().encode('示例'), roomA.id)
    const host = createHostLayerNxt(binding(roomA.id, { media: true }, 'host'), backends)
    // The host instance reads library Assets only.
    await expect(host.media.probe({ assetId: asset.id })).rejects.toThrow('不在当前频道或扩展资源库里')
    const nxt = createNxtHostService(binding(roomA.id, { media: true }), backends)
    await expect(nxt.media.probe({ assetId: asset.id })).rejects.toThrow('「设置 → 附加功能」安装')
  })
})

describe('nxt.commands', () => {
  it('runs declared profiles in a fresh work folder and returns output files', async () => {
    const seen: { inputs: Readonly<Record<string, string>>; workDir: string }[] = []
    const commands: NxtServiceBackends['commands'] = {
      available: () => [FFMPEG_PROFILE],
      async run(profileId, args, options) {
        seen.push({ inputs: options.inputs, workDir: options.workDir })
        expect(profileId).toBe('ffmpeg')
        expect(args).toEqual(['-i', { input: 'clip' }, { output: 'cover.png' }])
        expect(options.timeoutMs).toBe(30_000)
        const file = path.join(options.workDir, 'cover.png')
        await writeFile(file, 'PNG')
        return {
          exitCode: 0,
          stdout: '',
          stderr: 'done',
          truncated: false,
          outputs: [{ name: 'cover.png', path: file, byteSize: 3 }],
        }
      },
    }
    const { backends, binding, roomA, inChannel, workFolders } = await setup({ commands })
    const asset = await inChannel(new TextEncoder().encode('示例视频'), roomA.id)
    const nxt = createNxtHostService(
      binding(roomA.id, { commands: { profiles: ['ffmpeg', 'ffprobe'] }, ...filesDeclared }),
      backends,
    )
    const result = await nxt.commands.run('ffmpeg', ['-i', { input: 'clip' }, { output: 'cover.png' }], {
      inputs: { clip: { assetId: asset.id } },
      timeoutSeconds: 30,
    })
    expect(result).toMatchObject({ exitCode: 0, stderr: 'done', outputs: [{ name: 'cover.png', byteSize: 3 }] })
    expect(Buffer.from((await nxt.files.read(result.outputs[0]!.fileId)).base64, 'base64').toString()).toBe('PNG')
    expect(path.isAbsolute(seen[0]!.inputs['clip']!)).toBe(true)
    await expect(stat(seen[0]!.workDir)).rejects.toThrow()
    expect(await workFolders()).toEqual([])
    expect(await nxt.commands.profiles()).toEqual([
      { id: 'ffmpeg', program: 'ffmpeg', available: true },
      { id: 'ffprobe', program: 'ffprobe', available: false },
    ])
  })

  it('refuses undeclared profiles and malformed arguments', async () => {
    const { backends, binding, roomA } = await setup({
      commands: { available: () => [], run: () => Promise.reject(new Error('unexpected run')) },
    })
    const nxt = createNxtHostService(
      binding(roomA.id, { commands: { profiles: ['ffprobe'] }, ...filesDeclared }),
      backends,
    )
    await expect(nxt.commands.run('ffmpeg', [])).rejects.toThrow('commands.profiles 中加入')
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- What untyped extension code may pass.
    await expect(nxt.commands.run('ffprobe', [{ path: '/etc/hosts' } as unknown as string])).rejects.toThrow(
      '{ input: 键 }',
    )
    const undeclared = createNxtHostService(binding(roomA.id, filesDeclared), backends)
    await expect(undeclared.commands.profiles()).rejects.toThrow('commands（运行程序）')
  })

  it('names the add-on to install while a profile has no program', async () => {
    const profiles = new CommandProfiles({
      programs: () => [],
      runner: new ConfinedProgramRunner({
        sandbox: { confine: () => Promise.reject(new Error('unused')) },
        confinement: { hidden: [], readable: [] },
      }),
      addonTitle: () => '媒体处理',
    })
    await expect(profiles.run('ffmpeg', [], { inputs: {}, workDir: '/unused' })).rejects.toThrow(
      new CommandProfileError('profile-unavailable', 'ffmpeg 不可用，请管理员到「设置 → 附加功能」安装媒体处理。'),
    )
  })
})

describe('nxt.speech', () => {
  it('transcribes Assets once by content and work files directly, within the declared rate', async () => {
    const speech: NxtServiceBackends['speech'] = {
      transcribe: vi.fn(() => Promise.resolve(transcript('文件里的话'))),
      transcribeOnce: vi.fn(() => Promise.resolve(transcript('频道里的话'))),
    }
    const { backends, binding, roomA, inChannel } = await setup({ speech })
    const asset = await inChannel(new TextEncoder().encode('示例语音'), roomA.id)
    const nxt = createNxtHostService(
      binding(roomA.id, { speech: { maxCallsPerMinute: 2 }, ...filesDeclared }),
      backends,
    )
    expect(await nxt.speech.transcribe({ assetId: asset.id }, { language: 'zh' })).toEqual(transcript('频道里的话'))
    expect(speech.transcribeOnce).toHaveBeenCalledWith(
      expect.objectContaining({ digest: asset.contentDigest, language: 'zh' }),
    )
    const recorded = await nxt.files.write({ text: '示例' })
    expect((await nxt.speech.transcribe({ fileId: recorded.fileId })).provider).toEqual({
      id: 'fixture-provider',
      title: '示例识别',
    })
    expect(speech.transcribe).toHaveBeenCalledTimes(1)
    await expect(nxt.speech.transcribe({ fileId: recorded.fileId })).rejects.toThrow('每分钟最多转写 2 次')
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- What untyped extension code may pass.
    await expect(nxt.speech.transcribe({ fileId: recorded.fileId }, { language: 'fr' as 'zh' })).rejects.toThrow(
      'language 只能是',
    )
  })

  it('passes on that speech recognition is unavailable and needs the declaration', async () => {
    const { backends, binding, roomA, inChannel } = await setup({
      speech: {
        transcribe: () => Promise.reject(new SpeechUnavailableError()),
        transcribeOnce: () => Promise.reject(new SpeechUnavailableError()),
      },
    })
    const asset = await inChannel(new TextEncoder().encode('示例语音'), roomA.id)
    const nxt = createNxtHostService(binding(roomA.id, { speech: { maxCallsPerMinute: 5 } }), backends)
    await expect(nxt.speech.transcribe({ assetId: asset.id })).rejects.toThrow('「设置 → 附加功能」安装或配置语音识别')
    const undeclared = createNxtHostService(binding(roomA.id, filesDeclared), backends)
    await expect(undeclared.speech.transcribe({ assetId: asset.id })).rejects.toThrow('speech（语音识别）')
  })
})

describe('verification placeholders', () => {
  it('answers media, commands and speech without running anything', async () => {
    const { backends, binding, roomA } = await setup(verificationMediaBackends())
    const nxt = createNxtHostService(
      binding(
        roomA.id,
        { media: true, commands: { profiles: ['ffmpeg'] }, speech: { maxCallsPerMinute: 5 }, ...filesDeclared },
        'verification',
      ),
      backends,
    )
    const sample = await nxt.files.write({ text: '示例' })
    const [frame] = await nxt.media.frames({ fileId: sample.fileId }, { format: 'png' })
    expect(frame).toMatchObject({ width: 1, height: 1 })
    expect(await nxt.files.stat(frame!.fileId)).toMatchObject({ mediaType: 'image/png' })
    expect(await nxt.media.audio({ fileId: sample.fileId }, { format: 'wav' })).toMatchObject({ sampleRate: 16000 })
    const run = await nxt.commands.run('ffmpeg', ['-i', { input: 'clip' }, { output: 'out.png' }], {
      inputs: { clip: { fileId: sample.fileId } },
    })
    expect(run).toMatchObject({ exitCode: 0, outputs: [{ name: 'out.png', byteSize: 0 }] })
    // Arguments are checked as a real run checks them.
    await expect(nxt.commands.run('ffmpeg', ['-i', 'https://example.com/a.mp4'])).rejects.toThrow()
    expect((await nxt.speech.transcribe({ fileId: sample.fileId })).text).toBe('验证用的固定文字')
  })
})

const programs = await findSystemMediaPrograms({
  platform: process.platform,
  pathEnv: process.env['PATH'],
  searchDirectories: commonMediaDirectories(),
  isFile: async (file) => (await stat(file).catch(() => undefined))?.isFile() === true,
  versionOf: () => Promise.resolve('fixture'),
})

describe.skipIf(programs === undefined)('nxt.media and nxt.commands with this device’s ffmpeg', () => {
  it('takes frames and runs ffprobe on a work file under a hidden data root', async () => {
    const { backends, binding, roomA, root } = await setup()
    const sandbox = await createProgramSandbox()
    try {
      // The data root is hidden from programs, as in a real host; inputs and the work folder are let through.
      const runner = new ConfinedProgramRunner({ sandbox, confinement: { hidden: [root], readable: [] } })
      const toolkit = new MediaToolkit({ programs: () => programs, runner })
      const profiles = new CommandProfiles({
        runner,
        programs: () => [
          { addon: 'media', provider: 'system', name: 'ffprobe', path: programs!.ffprobe, profile: FFPROBE_PROFILE },
        ],
      })
      const scratch = path.join(await temporary('nekro-nxt-media-clip-'), 'clip.mp4')
      await mkdir(path.dirname(scratch), { recursive: true })
      execFileSync(
        programs!.ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'testsrc=duration=2:size=160x120:rate=5',
          scratch,
        ],
        { stdio: 'pipe' },
      )
      const nxt = createNxtHostService(
        binding(roomA.id, { media: true, commands: { profiles: ['ffprobe'] }, ...filesDeclared }),
        { ...backends, media: toolkit, commands: profiles },
      )
      const clip = await nxt.files.write({ base64: readFileSync(scratch).toString('base64') })
      const frames = await nxt.media.frames({ fileId: clip.fileId }, { at: [0.5, 1.5], width: 80, format: 'jpeg' })
      expect(frames.map(({ width, height }) => [width, height])).toEqual([
        [80, 60],
        [80, 60],
      ])
      const probe = await nxt.commands.run('ffprobe', ['-show_format', '-of', 'json', { input: 'clip' }], {
        inputs: { clip: { fileId: clip.fileId } },
      })
      expect(probe.exitCode).toBe(0)
      expect(probe.stdout).toContain('"format_name"')
    } finally {
      await sandbox.dispose()
    }
  })
})
