import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { JsonValue } from '@nekro-nxt/contracts'
import { encodeSpeechWav, parseWav, splitAtQuiet, toSpeechSamples } from '../src/speech-audio.ts'
import { requestTranscription, SpeechCloud } from '../src/speech-cloud.ts'
import { forkSpeechEngine, SpeechEngine, type SpeechEngineChild } from '../src/speech-engine.ts'
import { LocalSpeech } from '../src/speech-local.ts'
import type * as SpeechModelFiles from '../src/speech-model-files.ts'
import { SpeechService, SpeechUnavailableError } from '../src/speech-service.ts'

// Small stand-ins for the pinned downloads, so installs run against a fake network: `[name, content]`.
const pins = vi.hoisted(
  () =>
    ({
      node: ['sherpa-onnx-node', 'js package'],
      native: ['sherpa-onnx-linux-x64', 'native package'],
      vad: ['silero_vad_v5.onnx', 'vad model'],
      paraformer: [
        ['model.int8.onnx', 'paraformer model'],
        ['tokens.txt', 'paraformer tokens'],
      ],
      senseVoice: [
        ['model.int8.onnx', 'sense voice model'],
        ['tokens.txt', 'sense voice tokens'],
      ],
    }) as const,
)
const bytesOf = (entries: readonly (readonly [string, string])[]) =>
  entries.reduce((sum, [, content]) => sum + Buffer.byteLength(content), 0)

vi.mock('../src/speech-model-files.ts', async (importOriginal) => {
  const original = await importOriginal<typeof SpeechModelFiles>()
  const { createHash: hash } = await import('node:crypto')
  const pin = ([name, content]: readonly [string, string]) =>
    [name, Buffer.byteLength(content), hash('sha256').update(content).digest('hex')] as const
  return {
    ...original,
    SHERPA_ONNX_NODE: pin(pins.node),
    SHERPA_ONNX_NATIVE: { 'linux-x64': pin(pins.native) },
    SILERO_VAD: { ...original.SILERO_VAD, file: pin(pins.vad) },
    LOCAL_SPEECH_MODELS: {
      'paraformer-zh-small': {
        ...original.LOCAL_SPEECH_MODELS['paraformer-zh-small'],
        files: pins.paraformer.map((entry) => pin(entry)),
      },
      'sense-voice-small': {
        ...original.LOCAL_SPEECH_MODELS['sense-voice-small'],
        files: pins.senseVoice.map((entry) => pin(entry)),
      },
    },
  }
})

const temporaryDirectories: string[] = []
const servers: Server[] = []
const temporary = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-speech-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

/** Serves the fake pins by file name; `corrupt` lists hosts that send wrong bytes. */
const fakeNetwork = (corrupt: readonly string[] = []) => {
  const requests: string[] = []
  const bodies = new Map<string, string>([
    [`${pins.node[0]}-2.0.1.tgz`, pins.node[1]],
    [`${pins.native[0]}-2.0.1.tgz`, pins.native[1]],
    [pins.vad[0], pins.vad[1]],
  ])
  const fetch = (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input)
    requests.push(url.href)
    if (corrupt.includes(url.host)) return Promise.resolve(new Response('tampered'))
    const name = path.posix.basename(url.pathname)
    const model = url.pathname.includes('paraformer') ? pins.paraformer : pins.senseVoice
    const body = bodies.get(name) ?? model.find((entry) => entry[0] === name)?.[1]
    return Promise.resolve(body === undefined ? new Response('missing', { status: 404 }) : new Response(body))
  }
  return { fetch, requests }
}

// Unpacks a "tarball" by writing the npm layout it would contain.
const fakeUnpack = async (archive: string, destination: string) => {
  await mkdir(path.join(destination, 'package'), { recursive: true })
  await writeFile(path.join(destination, 'package', 'index.js'), path.basename(archive))
}

const settled = async (local: LocalSpeech, id: 'paraformer-zh-small' | 'sense-voice-small') => {
  await vi.waitFor(() => expect(local.install(id).state).not.toBe('downloading'))
  return local.install(id)
}

describe('local speech install', () => {
  it('installs a model with the shared runtime and detector, and finds it again at start', async () => {
    const root = await temporary()
    const network = fakeNetwork()
    const local = new LocalSpeech({ root, platform: 'linux', arch: 'x64', fetch: network.fetch, unpack: fakeUnpack })
    await local.prepare()
    expect(local.downloadBytes('paraformer-zh-small')).toBe(
      bytesOf([...pins.paraformer, pins.node, pins.native, pins.vad]),
    )

    const changes: string[] = []
    local.subscribe(() => changes.push(local.install('paraformer-zh-small').state))
    local.startDownload('paraformer-zh-small')
    expect(await settled(local, 'paraformer-zh-small')).toEqual({ state: 'installed' })
    expect(changes[0]).toBe('downloading')
    expect(changes.at(-1)).toBe('installed')
    expect(network.requests).toContain(
      'https://registry.npmjs.org/sherpa-onnx-linux-x64/-/sherpa-onnx-linux-x64-2.0.1.tgz',
    )
    expect(existsSync(path.join(root, 'sherpa-onnx', '2.0.1', 'node_modules', 'sherpa-onnx-node', 'index.js'))).toBe(
      true,
    )
    expect(existsSync(path.join(root, 'sherpa-onnx', '2.0.1', 'node_modules', 'sherpa-onnx-linux-x64'))).toBe(true)
    // The other model now downloads only its own files.
    expect(local.downloadBytes('sense-voice-small')).toBe(bytesOf(pins.senseVoice))

    const again = new LocalSpeech({ root, platform: 'linux', arch: 'x64' })
    await again.prepare()
    expect(again.install('paraformer-zh-small')).toEqual({ state: 'installed' })
    expect(again.install('sense-voice-small')).toEqual({ state: 'not-installed' })
    local.dispose()
    again.dispose()
  })

  it('falls back to the next source when a file does not match, and fails when none does', async () => {
    const network = fakeNetwork(['registry.npmjs.org', 'huggingface.co'])
    const local = new LocalSpeech({
      root: await temporary(),
      platform: 'linux',
      arch: 'x64',
      fetch: network.fetch,
      unpack: fakeUnpack,
    })
    await local.prepare()
    local.startDownload('paraformer-zh-small')
    expect(await settled(local, 'paraformer-zh-small')).toEqual({ state: 'installed' })
    expect(network.requests.some((url) => url.startsWith('https://registry.npmmirror.com/'))).toBe(true)
    expect(network.requests.some((url) => url.startsWith('https://hf-mirror.com/'))).toBe(true)

    const broken = fakeNetwork(['registry.npmjs.org', 'registry.npmmirror.com'])
    const failing = new LocalSpeech({
      root: await temporary(),
      platform: 'linux',
      arch: 'x64',
      fetch: broken.fetch,
      unpack: fakeUnpack,
    })
    await failing.prepare()
    failing.startDownload('sense-voice-small')
    const failed = await settled(failing, 'sense-voice-small')
    expect(failed).toMatchObject({ state: 'failed' })
    expect(failed.state === 'failed' ? failed.error : '').toContain('校验不通过')
    local.dispose()
    failing.dispose()
  })

  it('keeps the shared files until the last local model is removed', async () => {
    const root = await temporary()
    const network = fakeNetwork()
    const local = new LocalSpeech({ root, platform: 'linux', arch: 'x64', fetch: network.fetch, unpack: fakeUnpack })
    await local.prepare()
    local.startDownload('paraformer-zh-small')
    local.startDownload('sense-voice-small')
    expect(await settled(local, 'paraformer-zh-small')).toEqual({ state: 'installed' })
    expect(await settled(local, 'sense-voice-small')).toEqual({ state: 'installed' })
    // Both installs share one fetch of the runtime.
    expect(network.requests.filter((url) => url.endsWith('sherpa-onnx-node-2.0.1.tgz'))).toHaveLength(1)

    await local.remove('paraformer-zh-small')
    expect(local.install('paraformer-zh-small')).toEqual({ state: 'not-installed' })
    expect(local.install('sense-voice-small')).toEqual({ state: 'installed' })
    expect((await readdir(root)).sort()).toEqual(['models', 'sherpa-onnx', 'vad'])
    expect(await readdir(path.join(root, 'models'))).toEqual(['sense-voice-small'])

    await local.remove('sense-voice-small')
    expect((await readdir(root)).sort()).toEqual(['models'])
    expect(await readdir(path.join(root, 'models'))).toEqual([])
    local.dispose()
  })

  it('reports platforms without a native build as unsupported', async () => {
    const local = new LocalSpeech({ root: await temporary(), platform: 'win32', arch: 'ia32' })
    expect(local.supported).toBe(false)
    expect(() => local.startDownload('paraformer-zh-small')).toThrow('不能运行本地语音识别')
    local.dispose()
  })
})

const SentSchema = z.object({ id: z.number(), wav: z.string(), model: z.object({ model: z.string() }) })

/** A child process that answers when the test says so. */
class FakeChild extends EventEmitter implements SpeechEngineChild {
  readonly sent: z.output<typeof SentSchema>[] = []
  killed = false
  send(message: unknown): boolean {
    this.sent.push(SentSchema.parse(message))
    return true
  }
  kill(): boolean {
    this.killed = true
    queueMicrotask(() => this.emit('exit', null, 'SIGKILL'))
    return true
  }
  reply(index: number, text: string): void {
    this.emit('message', { id: this.sent[index]!.id, result: { text, segments: [{ start: 0, end: 1, text }] } })
  }
}

const engineRequest = (wav: string, model = '/models/a.onnx') => ({
  model: { kind: 'paraformer' as const, model, tokens: '/models/tokens.txt' },
  vad: '/models/vad.onnx',
  wav,
  language: 'auto',
})

const fakeEngine = (idleMs?: number) => {
  const children: FakeChild[] = []
  const engine = new SpeechEngine({
    start: () => {
      const child = new FakeChild()
      children.push(child)
      return child
    },
    ...(idleMs === undefined ? {} : { idleMs }),
  })
  return { engine, children }
}

describe('speech engine', () => {
  it('runs one request at a time in one process', async () => {
    const { engine, children } = fakeEngine()
    const first = engine.run(engineRequest('/audio/1.wav'), { timeoutMs: 1000 })
    const second = engine.run(engineRequest('/audio/2.wav'), { timeoutMs: 1000 })
    await vi.waitFor(() => expect(children[0]?.sent).toHaveLength(1))
    children[0]!.reply(0, '第一段')
    expect(await first).toEqual({ text: '第一段', segments: [{ start: 0, end: 1, text: '第一段' }] })
    await vi.waitFor(() => expect(children[0]!.sent).toHaveLength(2))
    expect(children[0]!.sent[1]).toMatchObject({ wav: '/audio/2.wav', model: { model: '/models/a.onnx' } })
    children[0]!.reply(1, '第二段')
    expect((await second).text).toBe('第二段')
    expect(children).toHaveLength(1)
    engine.dispose()
  })

  it('stops the process when a running request is cancelled, and skips a cancelled waiting one', async () => {
    const { engine, children } = fakeEngine()
    const running = new AbortController()
    const waiting = new AbortController()
    const first = engine.run(engineRequest('/audio/1.wav'), { timeoutMs: 1000, signal: running.signal })
    const second = engine.run(engineRequest('/audio/2.wav'), { timeoutMs: 1000, signal: waiting.signal })
    await vi.waitFor(() => expect(children[0]?.sent).toHaveLength(1))
    waiting.abort(new Error('不要了'))
    await expect(second).rejects.toThrow('不要了')
    running.abort(new Error('取消'))
    await expect(first).rejects.toThrow('取消')
    expect(children[0]!.killed).toBe(true)
    // The next request starts a fresh process; the skipped one never reached any.
    const third = engine.run(engineRequest('/audio/3.wav'), { timeoutMs: 1000 })
    await vi.waitFor(() => expect(children[1]?.sent).toHaveLength(1))
    expect(children.flatMap((child) => child.sent.map((message) => message.wav))).toEqual([
      '/audio/1.wav',
      '/audio/3.wav',
    ])
    children[1]!.reply(0, '好')
    expect((await third).text).toBe('好')
    engine.dispose()
  })

  it('fails a request when the process dies or takes too long, then starts again', async () => {
    const { engine, children } = fakeEngine()
    const crashed = engine.run(engineRequest('/audio/1.wav'), { timeoutMs: 1000 })
    await vi.waitFor(() => expect(children[0]?.sent).toHaveLength(1))
    children[0]!.emit('exit', null, 'SIGSEGV')
    await expect(crashed).rejects.toThrow('语音识别意外中断（SIGSEGV）')

    const slow = engine.run(engineRequest('/audio/2.wav'), { timeoutMs: 20 })
    await expect(slow).rejects.toThrow('语音识别超时。')
    expect(children[1]!.killed).toBe(true)

    const failing = engine.run(engineRequest('/audio/3.wav'), { timeoutMs: 1000 })
    await vi.waitFor(() => expect(children[2]?.sent).toHaveLength(1))
    children[2]!.emit('message', { id: children[2]!.sent[0]!.id, error: 'model not found' })
    await expect(failing).rejects.toThrow('语音识别出错：model not found')
    engine.dispose()
  })

  it('releases the process after idling and when the model changes', async () => {
    const { engine, children } = fakeEngine(30)
    const first = engine.run(engineRequest('/audio/1.wav'), { timeoutMs: 1000 })
    await vi.waitFor(() => expect(children[0]?.sent).toHaveLength(1))
    children[0]!.reply(0, '一')
    await first
    await vi.waitFor(() => expect(children[0]!.killed).toBe(true))
    expect(engine.running).toBe(false)

    const second = engine.run(engineRequest('/audio/2.wav'), { timeoutMs: 1000 })
    await vi.waitFor(() => expect(children[1]?.sent).toHaveLength(1))
    children[1]!.reply(0, '二')
    await second
    const switched = engine.run(engineRequest('/audio/3.wav', '/models/b.onnx'), { timeoutMs: 1000 })
    await vi.waitFor(() => expect(children[2]?.sent).toHaveLength(1))
    expect(children[1]!.killed).toBe(true)
    children[2]!.reply(0, '三')
    await switched
    engine.dispose()
  })

  // Runs the real engine when NXT_SPEECH_SMOKE_DIR holds node_modules/sherpa-onnx-node, a model, its tokens,
  // silero_vad.onnx and speech.wav (16 kHz mono); pass NXT_SPEECH_SMOKE_KIND=paraformer for a Paraformer model.
  const smoke = process.env['NXT_SPEECH_SMOKE_DIR']
  it.skipIf(smoke === undefined)(
    'recognizes speech with the real engine',
    async () => {
      const directory = smoke!
      const engine = new SpeechEngine({ start: () => forkSpeechEngine(directory) })
      const result = await engine.run(
        {
          model: {
            kind: process.env['NXT_SPEECH_SMOKE_KIND'] === 'paraformer' ? 'paraformer' : 'sense-voice',
            model: path.join(directory, 'model.int8.onnx'),
            tokens: path.join(directory, 'tokens.txt'),
          },
          vad: path.join(directory, 'silero_vad.onnx'),
          wav: path.join(directory, 'speech.wav'),
          language: 'auto',
        },
        { timeoutMs: 60_000 },
      )
      expect(result.text.length).toBeGreaterThan(0)
      expect(result.segments.length).toBeGreaterThan(0)
      expect(result.segments[0]!.end).toBeGreaterThan(result.segments[0]!.start)
      engine.dispose()
    },
    70_000,
  )
})

/** Samples of a tone with a silent gap at `silentFrom` seconds lasting half a second. */
const toneWithGap = (seconds: number, silentFrom: number): Int16Array => {
  const samples = new Int16Array(seconds * 16000)
  for (let index = 0; index < samples.length; index++) {
    const time = index / 16000
    const silent = time >= silentFrom && time < silentFrom + 0.5
    samples[index] = silent ? 0 : Math.round(Math.sin(index / 5) * 8000)
  }
  return samples
}

describe('speech audio', () => {
  it('reads what it writes and converts other rates and channel counts to 16 kHz mono', () => {
    const samples = toneWithGap(1, 0.2)
    const parsed = parseWav(encodeSpeechWav(samples))
    expect(parsed).toMatchObject({ sampleRate: 16000, channels: 1, encoding: 'pcm16' })
    expect(parsed!.data.byteLength).toBe(samples.byteLength)

    // 48 kHz stereo float: one second becomes 16000 samples.
    const frames = 48000
    const stereo = new Uint8Array(44 + frames * 8)
    const view = new DataView(stereo.buffer)
    stereo.set(new TextEncoder().encode('RIFF'), 0)
    stereo.set(new TextEncoder().encode('WAVEfmt '), 8)
    view.setUint32(16, 16, true)
    view.setUint16(20, 3, true)
    view.setUint16(22, 2, true)
    view.setUint32(24, 48000, true)
    view.setUint16(34, 32, true)
    stereo.set(new TextEncoder().encode('data'), 36)
    view.setUint32(40, frames * 8, true)
    for (let frame = 0; frame < frames; frame++) {
      view.setFloat32(44 + frame * 8, 0.5, true)
      view.setFloat32(48 + frame * 8, 0.25, true)
    }
    const info = parseWav(stereo)!
    const converted = toSpeechSamples(info)
    expect(converted).toHaveLength(16000)
    expect(converted[100]).toBe(Math.round(0.375 * 32768))
    expect(parseWav(new TextEncoder().encode('not audio'))).toBeUndefined()
  })

  it('cuts long audio at a quiet moment before the limit', () => {
    const pieces = splitAtQuiet(toneWithGap(50, 27), 30)
    expect(pieces).toHaveLength(2)
    const cut = pieces[1]!.start / 16000
    expect(cut).toBeGreaterThanOrEqual(27)
    expect(cut).toBeLessThanOrEqual(27.5)
    expect(pieces[0]!.samples.length + pieces[1]!.samples.length).toBe(50 * 16000)
    expect(splitAtQuiet(toneWithGap(5, 1), 30)).toHaveLength(1)
  })
})

interface ReceivedRequest {
  readonly authorization: string | undefined
  readonly fields: Record<string, string>
  readonly fileBytes: number
}

/** An OpenAI-compatible transcription endpoint that answers from `respond`. */
const transcriptionServer = async (respond: (request: ReceivedRequest, index: number) => Response) => {
  const received: ReceivedRequest[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      void (async () => {
        const form = await new Response(Buffer.concat(chunks), {
          headers: { 'content-type': req.headers['content-type'] ?? '' },
        }).formData()
        const fields: Record<string, string> = {}
        let fileBytes = 0
        for (const [name, value] of form.entries()) {
          if (typeof value === 'string') fields[name] = value
          else fileBytes = value.size
        }
        const request = { authorization: req.headers.authorization, fields, fileBytes }
        received.push(request)
        const response =
          req.url === '/v1/audio/transcriptions'
            ? respond(request, received.length - 1)
            : new Response('', { status: 404 })
        res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' })
        res.end(await response.text())
      })()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { baseURL: `http://127.0.0.1:${port}/v1`, received }
}

const memoryStore = () => {
  const values = new Map<string, JsonValue>()
  return {
    get: (key: string) => {
      const value = values.get(key)
      return value === undefined ? undefined : { value, revision: 1 }
    },
    put: (key: string, value: JsonValue) => void values.set(key, value),
  }
}

describe('cloud speech', () => {
  it('sends the audio as multipart and maps verbose segments', async () => {
    const stub = await transcriptionServer(() =>
      Response.json({
        text: ' 你好，世界 ',
        language: 'chinese',
        segments: [
          { id: 0, start: 0, end: 0.6, text: ' 你好，' },
          { id: 1, start: 0.6, end: 1, text: '世界' },
        ],
      }),
    )
    const result = await requestTranscription({
      baseURL: `${stub.baseURL}/`,
      apiKey: 'sk-test-fixture',
      model: 'whisper-1',
      wav: encodeSpeechWav(toneWithGap(1, 0.5)),
      durationSeconds: 1,
      language: 'zh',
    })
    expect(result).toEqual({
      text: '你好，世界',
      language: 'zh',
      segments: [
        { start: 0, end: 0.6, text: '你好，' },
        { start: 0.6, end: 1, text: '世界' },
      ],
    })
    expect(stub.received).toEqual([
      {
        authorization: 'Bearer sk-test-fixture',
        fields: { model: 'whisper-1', response_format: 'verbose_json', language: 'zh' },
        fileBytes: 44 + 32000,
      },
    ])
  })

  it('covers the whole piece when the provider returns no segments, and says why a request failed', async () => {
    const stub = await transcriptionServer(
      (_, index) =>
        [
          Response.json({ text: '只有文字' }),
          new Response('plain words', { headers: { 'content-type': 'text/plain' } }),
          Response.json({ error: { message: 'Invalid API key' } }, { status: 401 }),
          Response.json({ error: { message: 'model not found' } }, { status: 404 }),
          Response.json({ error: 'slow down' }, { status: 429 }),
          new Response('upstream down', { status: 502 }),
        ][index]!,
    )
    const call = () =>
      requestTranscription({
        baseURL: stub.baseURL,
        model: 'FunAudioLLM/SenseVoiceSmall',
        wav: encodeSpeechWav(new Int16Array(16000 * 2)),
        durationSeconds: 2,
        language: 'auto',
      })
    expect(await call()).toEqual({ text: '只有文字', segments: [{ start: 0, end: 2, text: '只有文字' }] })
    expect(await call()).toEqual({ text: 'plain words', segments: [{ start: 0, end: 2, text: 'plain words' }] })
    expect(stub.received[0]!.fields).not.toHaveProperty('language')
    expect(stub.received[0]!.authorization).toBeUndefined()
    await expect(call()).rejects.toThrow('语音识别供应商拒绝了请求，请到「设置 → 模型」检查 API 密钥：Invalid API key')
    await expect(call()).rejects.toThrow('语音识别供应商没有这个模型或转写接口：model not found')
    await expect(call()).rejects.toThrow('语音识别供应商限流或额度不足，请稍后再试：slow down')
    await expect(call()).rejects.toThrow('语音识别请求失败（HTTP 502）：upstream down')
  })

  it('sends long audio in pieces and keeps segment times relative to the whole audio', async () => {
    const stub = await transcriptionServer((_, index) =>
      Response.json({ text: `第${index + 1}段`, segments: [{ start: 1, end: 2, text: `第${index + 1}段` }] }),
    )
    const cloud = new SpeechCloud({
      settings: memoryStore(),
      providers: () =>
        Promise.resolve([
          {
            provider: 'example-relay',
            displayName: '示例中转',
            configured: true,
            baseURL: stub.baseURL,
            api: 'openai-completions',
          },
        ]),
      connection: () => Promise.resolve({ baseURL: stub.baseURL, apiKey: 'sk-test-fixture' }),
    })
    await cloud.update({ provider: 'example-relay', model: 'whisper-1', language: 'ja' })
    const result = await cloud.transcribe(toneWithGap(50, 27), {})
    expect(stub.received).toHaveLength(2)
    expect(stub.received.map((request) => request.fields['language'])).toEqual(['ja', 'ja'])
    const cut = Math.round((splitAtQuiet(toneWithGap(50, 27), 30)[1]!.start / 16000) * 100) / 100
    expect(result).toEqual({
      text: '第1段第2段',
      segments: [
        { start: 1, end: 2, text: '第1段' },
        { start: Math.round((cut + 1) * 100) / 100, end: Math.round((cut + 2) * 100) / 100, text: '第2段' },
      ],
      model: 'whisper-1',
    })
    // A language named by the caller wins over the configured one.
    await cloud.transcribe(toneWithGap(2, 1), { language: 'auto' })
    expect(stub.received[2]!.fields).not.toHaveProperty('language')
  })
})

describe('speech service', () => {
  const wavFile = async (directory: string, bytes: Uint8Array) => {
    const file = path.join(directory, 'input.wav')
    await writeFile(file, bytes)
    return file
  }

  const service = (overrides: {
    active?: string
    decode?: ConstructorParameters<typeof SpeechService>[0]['decode']
    cacheDirectory: string
  }) => {
    const local = {
      calls: [] as { id: string; wav: string; language: string }[],
      transcribe: (id: string, wav: string, options: { readonly language: string }) => {
        local.calls.push({ id, wav, language: options.language })
        return Promise.resolve({ text: '本地结果', language: 'zh', segments: [{ start: 0, end: 1, text: '本地结果' }] })
      },
    }
    const cloud = {
      samples: [] as number[],
      settings: () => ({ provider: 'example-relay', model: 'whisper-1' }),
      transcribe: (samples: Int16Array) => {
        cloud.samples.push(samples.length)
        return Promise.resolve({ text: '云端结果', segments: [], model: 'whisper-1' })
      },
    }
    const active = overrides.active
    return {
      local,
      cloud,
      speech: new SpeechService({
        active: () => (active === undefined ? undefined : { id: active, program: () => undefined }),
        titles: { 'sense-voice-small': '本地 SenseVoice', cloud: '云端' },
        local,
        cloud,
        cacheDirectory: overrides.cacheDirectory,
        ...(overrides.decode === undefined ? {} : { decode: overrides.decode }),
      }),
    }
  }

  it('uses the active provider and names it in the result', async () => {
    const directory = await temporary()
    const input = await wavFile(directory, encodeSpeechWav(toneWithGap(2, 1)))
    const local = service({ active: 'sense-voice-small', cacheDirectory: path.join(directory, 'cache') })
    expect(await local.speech.transcribe({ path: input, language: 'yue' })).toEqual({
      text: '本地结果',
      language: 'zh',
      segments: [{ start: 0, end: 1, text: '本地结果' }],
      durationSeconds: 2,
      provider: { id: 'sense-voice-small', title: '本地 SenseVoice' },
      model: 'sense-voice-small-int8',
    })
    // A 16 kHz mono WAV goes to the engine as it is.
    expect(local.local.calls).toEqual([{ id: 'sense-voice-small', wav: input, language: 'yue' }])

    const cloud = service({ active: 'cloud', cacheDirectory: path.join(directory, 'cache') })
    expect(await cloud.speech.transcribe({ path: input })).toMatchObject({
      text: '云端结果',
      provider: { id: 'cloud', title: '云端' },
      model: 'whisper-1',
    })
    expect(cloud.cloud.samples).toEqual([32000])

    const none = service({ cacheDirectory: path.join(directory, 'cache') })
    await expect(none.speech.transcribe({ path: input })).rejects.toBeInstanceOf(SpeechUnavailableError)
    await expect(none.speech.transcribe({ path: input })).rejects.toThrow(
      '请管理员到「设置 → 附加功能」安装或配置语音识别',
    )
  })

  it('decodes other audio with the decoder, and needs one for anything but WAV', async () => {
    const directory = await temporary()
    const input = path.join(directory, 'voice.silk')
    await writeFile(input, 'fictional voice message')
    const without = service({ active: 'sense-voice-small', cacheDirectory: path.join(directory, 'cache') })
    await expect(without.speech.transcribe({ path: input })).rejects.toThrow('no audio decoder is available')

    const decoded: string[] = []
    const withDecoder = service({
      active: 'sense-voice-small',
      cacheDirectory: path.join(directory, 'cache'),
      decode: async (from, to, options) => {
        decoded.push(`${path.basename(from)} ${options.sampleRate} ${options.channels}`)
        await writeFile(to, encodeSpeechWav(toneWithGap(1, 0.5)))
      },
    })
    expect(await withDecoder.speech.transcribe({ path: input })).toMatchObject({ durationSeconds: 1 })
    expect(decoded).toEqual(['voice.silk 16000 1'])
    expect(path.basename(withDecoder.local.calls[0]!.wav)).toBe('decoded.wav')
    // The work folder is gone afterwards.
    expect(existsSync(path.dirname(withDecoder.local.calls[0]!.wav))).toBe(false)
  })

  it('transcribes the same audio once per provider, model and language', async () => {
    const directory = await temporary()
    const input = await wavFile(directory, encodeSpeechWav(toneWithGap(1, 0.5)))
    const { speech, local } = service({ active: 'sense-voice-small', cacheDirectory: path.join(directory, 'cache') })
    const digest = createHash('sha256').update('fictional audio').digest('hex')
    const first = await speech.transcribeOnce({ path: input, digest })
    expect(await speech.transcribeOnce({ path: input, digest })).toEqual(first)
    expect(local.calls).toHaveLength(1)
    await speech.transcribeOnce({ path: input, digest, language: 'zh' })
    expect(local.calls).toHaveLength(2)
  })
})
