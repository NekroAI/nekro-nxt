import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { MODEL_FILE_SOURCES } from './retrieval-model-files.js'
import { downloadPinnedFile, pinnedFileVerified, type PinnedDownload } from './runtime-download.js'
import { SpeechEngine, forkSpeechEngine, type SpeechEngineChild, type SpeechEngineResult } from './speech-engine.js'
import {
  LOCAL_SPEECH_MODELS,
  NPM_TARBALL_SOURCES,
  SHERPA_ONNX_NATIVE,
  SHERPA_ONNX_NODE,
  SHERPA_ONNX_VERSION,
  SILERO_VAD,
  type LocalSpeechModel,
  type LocalSpeechModelId,
  type PinnedPackage,
} from './speech-model-files.js'

const run = promisify(execFile)

/** Where one local model's install stands. */
export type LocalSpeechInstall =
  | { readonly state: 'not-installed' }
  | { readonly state: 'downloading'; readonly receivedBytes: number; readonly totalBytes: number }
  | { readonly state: 'installed' }
  | { readonly state: 'failed'; readonly error: string }

export interface LocalSpeechOptions {
  /** `<data root>/runtimes/speech`. */
  readonly root: string
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly fetch?: typeof fetch
  /** Starts the engine process; tests pass a fake. */
  readonly startEngine?: (runtimeDirectory: string) => SpeechEngineChild
  /** Unpacks an npm tarball into a folder; defaults to the system `tar`. */
  readonly unpack?: (archive: string, destination: string) => Promise<void>
  readonly engineIdleMs?: number
}

const systemUnpack = async (archive: string, destination: string): Promise<void> => {
  await mkdir(destination, { recursive: true })
  await run('tar', ['-xzf', archive, '-C', destination])
}

/** A piece of the install: the shared runtime, the shared detector or one model's files. */
interface Part {
  readonly key: string
  readonly bytes: number
  installed(): Promise<boolean>
  install(onProgress: (received: number) => void): Promise<void>
}

/**
 * Local speech recognition (附加功能 F9): sherpa-onnx and Silero VAD shared by every local model, plus each model's
 * own files, all under `<data root>/runtimes/speech`. Removing a model keeps the shared files while another model is
 * installed or installing; removing the last one removes them too. Recognition runs in a separate engine process.
 */
export class LocalSpeech {
  readonly #options: LocalSpeechOptions
  readonly #platformKey: string
  readonly #listeners = new Set<() => void>()
  readonly #installs = new Map<LocalSpeechModelId, LocalSpeechInstall>()
  readonly #inflight = new Map<LocalSpeechModelId, Promise<void>>()
  /** Shared pieces being fetched, so two model installs do not fetch them twice. */
  readonly #sharedInflight = new Map<string, Promise<void>>()
  #sharedInstalled = false
  readonly #engine: SpeechEngine

  constructor(options: LocalSpeechOptions) {
    this.#options = options
    this.#platformKey = `${options.platform ?? process.platform}-${options.arch ?? process.arch}`
    const start = options.startEngine ?? forkSpeechEngine
    this.#engine = new SpeechEngine({
      start: () => start(this.#runtimeRoot),
      ...(options.engineIdleMs === undefined ? {} : { idleMs: options.engineIdleMs }),
    })
  }

  get supported(): boolean {
    return SHERPA_ONNX_NATIVE[this.#platformKey] !== undefined
  }

  get #runtimeRoot(): string {
    return path.join(this.#options.root, 'sherpa-onnx', SHERPA_ONNX_VERSION)
  }

  get #vadPath(): string {
    return path.join(this.#options.root, 'vad', SILERO_VAD.revision, SILERO_VAD.file[0])
  }

  #modelRoot(model: LocalSpeechModel): string {
    return path.join(this.#options.root, 'models', model.id, model.revision)
  }

  #runtimePart(): Part {
    const native = SHERPA_ONNX_NATIVE[this.#platformKey]
    const packages = native === undefined ? [SHERPA_ONNX_NODE] : [SHERPA_ONNX_NODE, native]
    const marker = path.join(this.#runtimeRoot, 'installed.json')
    return {
      key: 'runtime',
      bytes: packages.reduce((sum, entry) => sum + entry[1], 0),
      installed: async () => {
        try {
          const recorded: unknown = JSON.parse(await readFile(marker, 'utf8'))
          return (
            typeof recorded === 'object' && recorded !== null && Reflect.get(recorded, 'platform') === this.#platformKey
          )
        } catch {
          return false
        }
      },
      install: async (onProgress) => {
        await rm(this.#runtimeRoot, { recursive: true, force: true })
        let done = 0
        for (const entry of packages) {
          await this.#installPackage(entry, (received) => onProgress(done + received))
          done += entry[1]
        }
        await writeFile(marker, JSON.stringify({ platform: this.#platformKey, version: SHERPA_ONNX_VERSION }))
      },
    }
  }

  async #installPackage([name, bytes, sha256]: PinnedPackage, onProgress: (received: number) => void): Promise<void> {
    const staging = path.join(this.#options.root, `.staging-${randomUUID()}`)
    const archive = path.join(staging, `${name}.tgz`)
    try {
      await downloadPinnedFile(
        {
          target: archive,
          bytes,
          sha256,
          urls: NPM_TARBALL_SOURCES.map((source) => source(name, SHERPA_ONNX_VERSION)),
        },
        { ...this.#fetch(), onProgress },
      )
      await (this.#options.unpack ?? systemUnpack)(archive, path.join(staging, 'unpacked'))
      const target = path.join(this.#runtimeRoot, 'node_modules', name)
      await mkdir(path.dirname(target), { recursive: true })
      await rename(path.join(staging, 'unpacked', 'package'), target)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  #filePart(key: string, entry: PinnedDownload): Part {
    return {
      key,
      bytes: entry.bytes,
      // Sizes are checked at every start; hashes were checked when the files arrived.
      installed: async () => (await stat(entry.target).catch(() => undefined))?.size === entry.bytes,
      install: async (onProgress) => {
        if (await pinnedFileVerified(entry.target, entry.bytes, entry.sha256)) return
        await downloadPinnedFile(entry, { ...this.#fetch(), onProgress })
      },
    }
  }

  #vadPart(): Part {
    const [file, bytes, sha256] = SILERO_VAD.file
    return this.#filePart('vad', {
      target: this.#vadPath,
      bytes,
      sha256,
      urls: [
        ...MODEL_FILE_SOURCES.map((source) => source(SILERO_VAD.repository, SILERO_VAD.revision, file)),
        SILERO_VAD.release,
      ],
    })
  }

  #modelParts(model: LocalSpeechModel): readonly Part[] {
    return model.files.map(([file, bytes, sha256]) =>
      this.#filePart(`${model.id}/${file}`, {
        target: path.join(this.#modelRoot(model), file),
        bytes,
        sha256,
        urls: MODEL_FILE_SOURCES.map((source) => source(model.repository, model.revision, file)),
      }),
    )
  }

  #marker(model: LocalSpeechModel): string {
    return path.join(this.#options.root, 'models', model.id, 'installed.json')
  }

  /** Looks at what is already on disk once at start. */
  async prepare(): Promise<void> {
    this.#sharedInstalled = (await this.#runtimePart().installed()) && (await this.#vadPart().installed())
    for (const model of Object.values(LOCAL_SPEECH_MODELS)) {
      const parts = this.#modelParts(model)
      const complete =
        this.#sharedInstalled &&
        (await readFile(this.#marker(model)).then(
          () => true,
          () => false,
        )) &&
        (await Promise.all(parts.map((part) => part.installed()))).every(Boolean)
      this.#installs.set(model.id, complete ? { state: 'installed' } : { state: 'not-installed' })
    }
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #changed(): void {
    for (const listener of this.#listeners) listener()
  }

  #fetch(): { readonly fetch?: typeof fetch } {
    return this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }
  }

  install(id: LocalSpeechModelId): LocalSpeechInstall {
    return this.#installs.get(id) ?? { state: 'not-installed' }
  }

  /** Bytes an install fetches now: the model, plus the shared runtime and detector unless they are already here. */
  downloadBytes(id: LocalSpeechModelId): number {
    const model = this.#modelParts(LOCAL_SPEECH_MODELS[id]).reduce((sum, part) => sum + part.bytes, 0)
    return this.#sharedInstalled ? model : model + this.#runtimePart().bytes + this.#vadPart().bytes
  }

  /** Folders a model occupies, the shared ones included. */
  directories(id: LocalSpeechModelId): readonly string[] {
    return [
      path.join(this.#options.root, 'models', id),
      path.join(this.#options.root, 'sherpa-onnx'),
      path.join(this.#options.root, 'vad'),
    ]
  }

  startDownload(id: LocalSpeechModelId): void {
    if (!this.supported) throw new Error('这台设备的系统或处理器不能运行本地语音识别。')
    if (this.install(id).state === 'installed' || this.#inflight.has(id)) return
    this.#installs.set(id, { state: 'downloading', receivedBytes: 0, totalBytes: this.downloadBytes(id) })
    this.#inflight.set(
      id,
      this.#download(LOCAL_SPEECH_MODELS[id]).finally(() => {
        this.#inflight.delete(id)
        this.#changed()
      }),
    )
  }

  async #download(model: LocalSpeechModel): Promise<void> {
    const shared = [this.#runtimePart(), this.#vadPart()]
    const own = this.#modelParts(model)
    const parts: Part[] = []
    for (const part of shared) if (!(await part.installed())) parts.push(part)
    parts.push(...own)
    const totalBytes = parts.reduce((sum, part) => sum + part.bytes, 0)
    let doneBytes = 0
    let reported = -1
    const report = (receivedBytes: number) => {
      this.#installs.set(model.id, { state: 'downloading', receivedBytes, totalBytes })
      if (receivedBytes - reported >= 1024 * 1024 || receivedBytes === totalBytes) {
        reported = receivedBytes
        this.#changed()
      }
    }
    report(0)
    try {
      for (const part of parts) {
        const progress = (received: number) => report(doneBytes + received)
        await (shared.includes(part) ? this.#ensureShared(part, progress) : part.install(progress))
        doneBytes += part.bytes
        report(doneBytes)
      }
      await writeFile(this.#marker(model), JSON.stringify({ revision: model.revision }))
      this.#sharedInstalled = true
      this.#installs.set(model.id, { state: 'installed' })
    } catch (error) {
      this.#installs.set(model.id, { state: 'failed', error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Another model's install may be fetching the same shared piece, or may have finished it meanwhile. */
  #ensureShared(part: Part, onProgress: (received: number) => void): Promise<void> {
    let running = this.#sharedInflight.get(part.key)
    if (running === undefined) {
      running = (async () => {
        if (!(await part.installed())) await part.install(onProgress)
      })().finally(() => this.#sharedInflight.delete(part.key))
      this.#sharedInflight.set(part.key, running)
    }
    return running
  }

  async remove(id: LocalSpeechModelId): Promise<void> {
    if (this.#inflight.has(id)) throw new Error('正在下载，等下载结束后再删除。')
    this.#engine.stop()
    await rm(path.join(this.#options.root, 'models', id), { recursive: true, force: true })
    this.#installs.set(id, { state: 'not-installed' })
    const others = Object.values(LOCAL_SPEECH_MODELS).filter(
      (model) => model.id !== id && (this.install(model.id).state === 'installed' || this.#inflight.has(model.id)),
    )
    if (others.length === 0) {
      await rm(path.join(this.#options.root, 'sherpa-onnx'), { recursive: true, force: true })
      await rm(path.join(this.#options.root, 'vad'), { recursive: true, force: true })
      this.#sharedInstalled = false
    }
    this.#changed()
  }

  /** Recognizes a 16 kHz mono WAV with an installed model. */
  transcribe(
    id: LocalSpeechModelId,
    wav: string,
    options: { readonly language: string; readonly signal?: AbortSignal; readonly durationSeconds: number },
  ): Promise<SpeechEngineResult> {
    if (this.install(id).state !== 'installed') return Promise.reject(new Error('这个语音识别模型还没有安装。'))
    const model = LOCAL_SPEECH_MODELS[id]
    const root = this.#modelRoot(model)
    return this.#engine.run(
      {
        model: {
          kind: model.kind,
          model: path.join(root, model.files[0][0]),
          tokens: path.join(root, model.files[1][0]),
        },
        vad: this.#vadPath,
        wav,
        language: model.kind === 'sense-voice' ? options.language : 'zh',
      },
      // Loading takes about a second and recognition runs well under real time; leave a wide margin.
      {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        timeoutMs: 60_000 + options.durationSeconds * 1000,
      },
    )
  }

  dispose(): void {
    this.#engine.dispose()
  }
}
