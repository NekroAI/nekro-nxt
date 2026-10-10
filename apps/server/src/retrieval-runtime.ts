import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { JsonValue, RetrievalMode, RetrievalStatus } from '@nekro-nxt/contracts'
import type { ExtensionIndexRepository } from '@nekro-nxt/storage-sqlite'
import { embeddingText, embeddingTextDigest, quantizeVector, type IndexVectorProvider } from './extension-index.js'
import {
  BUILTIN_EMBEDDING_MODEL,
  MODEL_FILE_SOURCES,
  NPM_FILE_SOURCES,
  ONNXRUNTIME_COMMON_FILES,
  ONNXRUNTIME_NATIVE_FILES,
  ONNXRUNTIME_NODE_FILES,
  ONNXRUNTIME_VERSION,
  type PinnedFile,
} from './retrieval-model-files.js'

const SETTING_KEY = 'retrieval'
/** Bumped when the text a document is embedded from changes, so old vectors are rebuilt. */
const TEXT_TEMPLATE_VERSION = 1
const BUILTIN_SPACE = `builtin:${BUILTIN_EMBEDDING_MODEL.id}:${BUILTIN_EMBEDDING_MODEL.revision.slice(0, 8)}:${BUILTIN_EMBEDDING_MODEL.dimensions}:t${TEXT_TEMPLATE_VERSION}`
/** A loaded model is released after this long without use; loading again takes a fraction of a second. */
const IDLE_RELEASE_MS = 10 * 60 * 1000
const EMBED_BATCH = 16
const MAX_TOKENS = 256

export interface RetrievalSettingsStore {
  get(key: string): { readonly value: JsonValue; readonly revision: number } | undefined
  put(key: string, value: JsonValue, expectedRevision: number | undefined): void
}

export interface RetrievalRuntimeOptions {
  /** `<data root>/runtimes`; shared with other downloaded runtimes and left out of backups. */
  readonly root: string
  readonly index: ExtensionIndexRepository
  readonly settings: RetrievalSettingsStore
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly fetch?: typeof fetch
  /** Inference threads; two keep small servers responsive while vectors are built. */
  readonly threads?: number
}

interface OrtSession {
  readonly inputNames: readonly string[]
  run(
    feeds: Record<string, unknown>,
  ): Promise<Record<string, { readonly data: Float32Array; readonly dims: readonly number[] }>>
  release(): Promise<void>
}

interface OrtModule {
  readonly InferenceSession: {
    create(model: Uint8Array, options: Record<string, unknown>): Promise<OrtSession>
  }
  readonly Tensor: new (type: string, data: BigInt64Array, dims: readonly number[]) => unknown
}

interface TokenizerLike {
  encode(text: string): { readonly ids: ArrayLike<number> }
}

type TokenizerConstructor = new (tokenizerJson: unknown, tokenizerConfig: unknown) => TokenizerLike

interface LoadedModel {
  readonly ort: OrtModule
  readonly session: OrtSession
  readonly tokenizer: TokenizerLike
}

// The package's declarations use extensionless relative imports that NodeNext cannot resolve, so its types are
// unusable; the few members needed are checked here instead.
const isTokenizerConstructor = (value: unknown): value is TokenizerConstructor => typeof value === 'function'

const loadTokenizer = async (): Promise<TokenizerConstructor> => {
  const loaded: unknown = await import('@huggingface/tokenizers')
  const constructor =
    typeof loaded === 'object' && loaded !== null && 'Tokenizer' in loaded ? loaded.Tokenizer : undefined
  if (!isTokenizerConstructor(constructor)) throw new Error('分词器不可用。')
  return constructor
}

const isOrtModule = (value: unknown): value is OrtModule =>
  typeof value === 'object' &&
  value !== null &&
  'InferenceSession' in value &&
  typeof value.InferenceSession === 'function' &&
  'create' in value.InferenceSession &&
  typeof value.InferenceSession.create === 'function' &&
  'Tensor' in value &&
  typeof value.Tensor === 'function'

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/**
 * The built-in semantic search model (表情包与扩展素材能力 §6.4): downloaded on request into the data root, verified
 * file by file, loaded on first use and released when idle. Keyword search never depends on it; when it is missing,
 * still downloading or failing, queries fall back to keywords and say why.
 */
export class RetrievalRuntime implements IndexVectorProvider {
  readonly #options: RetrievalRuntimeOptions
  readonly #platformKey: string
  readonly #listeners = new Set<() => void>()
  #mode: RetrievalMode = 'keyword'
  #install: RetrievalStatus['builtin']['install'] = { state: 'not-installed' }
  #inflight: Promise<void> | undefined
  #model: Promise<LoadedModel> | undefined
  #idleTimer: NodeJS.Timeout | undefined
  #indexing: { state: 'idle' | 'running' | 'ready'; error?: string } = { state: 'idle' }
  #indexScheduled: NodeJS.Timeout | undefined
  #indexRun: Promise<void> | undefined
  #disposed = false

  constructor(options: RetrievalRuntimeOptions) {
    this.#options = options
    this.#platformKey = `${options.platform ?? process.platform}-${options.arch ?? process.arch}`
  }

  get #runtimeRoot(): string {
    return path.join(this.#options.root, 'onnxruntime', ONNXRUNTIME_VERSION)
  }

  get #modelRoot(): string {
    return path.join(
      this.#options.root,
      'embedding-models',
      BUILTIN_EMBEDDING_MODEL.id,
      BUILTIN_EMBEDDING_MODEL.revision,
    )
  }

  get #nativeFiles(): readonly PinnedFile[] | undefined {
    return ONNXRUNTIME_NATIVE_FILES[this.#platformKey]
  }

  /** Every file the built-in model needs, with where it comes from and where it goes. */
  #plan(): readonly { readonly target: string; readonly file: PinnedFile; readonly urls: readonly string[] }[] {
    const native = this.#nativeFiles ?? []
    const packageFiles = (name: string, files: readonly PinnedFile[]) =>
      files.map((file) => ({
        target: path.join(this.#runtimeRoot, 'node_modules', name, file[0]),
        file,
        urls: NPM_FILE_SOURCES.map((source) => source(name, ONNXRUNTIME_VERSION, file[0])),
      }))
    return [
      ...packageFiles('onnxruntime-common', ONNXRUNTIME_COMMON_FILES),
      ...packageFiles('onnxruntime-node', [...ONNXRUNTIME_NODE_FILES, ...native]),
      ...BUILTIN_EMBEDDING_MODEL.files.map((file) => ({
        target: path.join(this.#modelRoot, file[0]),
        file,
        urls: MODEL_FILE_SOURCES.map((source) =>
          source(BUILTIN_EMBEDDING_MODEL.repository, BUILTIN_EMBEDDING_MODEL.revision, file[0]),
        ),
      })),
    ]
  }

  get #marker(): string {
    return path.join(this.#options.root, 'embedding-models', `${BUILTIN_EMBEDDING_MODEL.id}.installed.json`)
  }

  async start(): Promise<void> {
    const stored = this.#options.settings.get(SETTING_KEY)?.value
    const mode = typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? stored['mode'] : undefined
    this.#mode = mode === 'builtin' ? 'builtin' : 'keyword'
    if (await this.#installed()) this.#install = { state: 'installed' }
    if (this.#mode === 'builtin') this.documentsChanged()
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    clearTimeout(this.#indexScheduled)
    clearTimeout(this.#idleTimer)
    await this.#indexRun
    await this.#release()
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #changed(): void {
    for (const listener of this.#listeners) listener()
  }

  status(): RetrievalStatus {
    const counts = this.#options.index.countIndexVectors(BUILTIN_SPACE)
    const totalBytes = this.#plan().reduce((sum, entry) => sum + entry.file[1], 0)
    return {
      mode: this.#mode,
      builtin: {
        model: BUILTIN_EMBEDDING_MODEL.id,
        supported: this.#nativeFiles !== undefined,
        downloadBytes: totalBytes,
        install: this.#install,
      },
      vectors: {
        documents: counts.documents,
        embedded: counts.vectors,
        state: this.#indexing.state,
        ...(this.#indexing.error === undefined ? {} : { error: this.#indexing.error }),
      },
    }
  }

  setMode(mode: RetrievalMode): RetrievalStatus {
    if (mode === 'builtin' && this.#install.state !== 'installed') {
      throw new Error('先下载内置语义模型，再开启语义检索。')
    }
    this.#options.settings.put(SETTING_KEY, { mode }, this.#options.settings.get(SETTING_KEY)?.revision)
    this.#mode = mode
    if (mode === 'builtin') this.documentsChanged()
    else void this.#release()
    this.#changed()
    return this.status()
  }

  /** Starts downloading the model and runtime; progress arrives through `status()` and `subscribe()`. */
  startDownload(): RetrievalStatus {
    if (this.#nativeFiles === undefined) throw new Error('这台设备的系统或处理器还不能运行内置语义模型。')
    if (this.#install.state === 'installed') return this.status()
    this.#inflight ??= this.#download().finally(() => {
      this.#inflight = undefined
      this.#changed()
    })
    return this.status()
  }

  async remove(): Promise<RetrievalStatus> {
    if (this.#inflight !== undefined) throw new Error('正在下载，等下载结束后再删除。')
    if (this.#mode === 'builtin') this.setMode('keyword')
    await this.#release()
    await rm(this.#marker, { force: true })
    await rm(path.join(this.#options.root, 'embedding-models', BUILTIN_EMBEDDING_MODEL.id), {
      recursive: true,
      force: true,
    })
    await rm(this.#runtimeRoot, { recursive: true, force: true })
    this.#install = { state: 'not-installed' }
    this.#changed()
    return this.status()
  }

  async #installed(): Promise<boolean> {
    try {
      const marker: unknown = JSON.parse(await readFile(this.#marker, 'utf8'))
      if (
        typeof marker !== 'object' ||
        marker === null ||
        !('platform' in marker) ||
        marker.platform !== this.#platformKey
      ) {
        return false
      }
      // Sizes are checked at every start; hashes were checked when the files arrived.
      for (const entry of this.#plan()) {
        if ((await stat(entry.target)).size !== entry.file[1]) return false
      }
      return true
    } catch {
      return false
    }
  }

  async #download(): Promise<void> {
    const plan = this.#plan()
    const totalBytes = plan.reduce((sum, entry) => sum + entry.file[1], 0)
    let doneBytes = 0
    let reported = 0
    const report = (receivedBytes: number) => {
      this.#install = { state: 'downloading', receivedBytes, totalBytes }
      if (receivedBytes - reported >= 1024 * 1024 || receivedBytes === totalBytes) {
        reported = receivedBytes
        this.#changed()
      }
    }
    report(0)
    try {
      for (const entry of plan) {
        if (await this.#verified(entry.target, entry.file)) {
          doneBytes += entry.file[1]
          report(doneBytes)
          continue
        }
        await this.#fetchFile(entry, (received) => report(doneBytes + received))
        doneBytes += entry.file[1]
        report(doneBytes)
      }
      await mkdir(path.dirname(this.#marker), { recursive: true })
      await writeFile(this.#marker, JSON.stringify({ platform: this.#platformKey, space: BUILTIN_SPACE }))
      this.#install = { state: 'installed' }
    } catch (error) {
      this.#install = { state: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
  }

  async #verified(target: string, file: PinnedFile): Promise<boolean> {
    try {
      if ((await stat(target)).size !== file[1]) return false
      return sha256(await readFile(target)) === file[2]
    } catch {
      return false
    }
  }

  /** Tries each source in turn; a file is published only after its size and hash match. */
  async #fetchFile(
    entry: { readonly target: string; readonly file: PinnedFile; readonly urls: readonly string[] },
    onProgress: (received: number) => void,
  ): Promise<void> {
    const [, size, digest] = entry.file
    await mkdir(path.dirname(entry.target), { recursive: true })
    const failures: string[] = []
    for (const url of entry.urls) {
      const staging = `${entry.target}.${randomUUID()}.part`
      try {
        const response = await (this.#options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(10 * 60 * 1000) })
        if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
        const hash = createHash('sha256')
        let received = 0
        const file = await open(staging, 'w')
        try {
          const reader = response.body.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            received += value.byteLength
            if (received > size) throw new Error('文件比预期大')
            hash.update(value)
            await file.write(value)
            onProgress(received)
          }
        } finally {
          await file.close()
        }
        if (received !== size || hash.digest('hex') !== digest) throw new Error('校验不通过')
        await rename(staging, entry.target)
        return
      } catch (error) {
        await rm(staging, { force: true })
        failures.push(`${new URL(url).host}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    throw new Error(`${path.basename(entry.target)} 下载失败（${failures.join('；')}）`)
  }

  async #load(): Promise<LoadedModel> {
    const loaded: unknown = createRequire(path.join(this.#runtimeRoot, 'package.json'))('onnxruntime-node')
    if (!isOrtModule(loaded)) throw new Error('推理运行库不完整，请删除后重新下载。')
    const ort = loaded
    const [model, tokenizerJson, tokenizerConfig] = await Promise.all([
      readFile(path.join(this.#modelRoot, 'onnx/model_quantized.onnx')),
      readFile(path.join(this.#modelRoot, 'tokenizer.json'), 'utf8'),
      readFile(path.join(this.#modelRoot, 'tokenizer_config.json'), 'utf8'),
    ])
    const session = await ort.InferenceSession.create(model, {
      intraOpNumThreads: this.#options.threads ?? 2,
      interOpNumThreads: 1,
      graphOptimizationLevel: 'all',
    })
    const Tokenizer = await loadTokenizer()
    const tokenizer = new Tokenizer(JSON.parse(tokenizerJson) as unknown, JSON.parse(tokenizerConfig) as unknown)
    return { ort, session, tokenizer }
  }

  async #release(): Promise<void> {
    clearTimeout(this.#idleTimer)
    const model = this.#model
    this.#model = undefined
    if (model === undefined) return
    try {
      await (await model).session.release()
    } catch {
      // A model that never loaded has nothing to release.
    }
  }

  /** Unit-length sentence vectors (the first token's state, as BGE is trained). */
  async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    if (this.#install.state !== 'installed') throw new Error('内置语义模型还没有下载。')
    this.#model ??= this.#load()
    let loaded: LoadedModel
    try {
      loaded = await this.#model
    } catch (error) {
      this.#model = undefined
      throw error
    }
    clearTimeout(this.#idleTimer)
    this.#idleTimer = setTimeout(() => void this.#release(), IDLE_RELEASE_MS)
    this.#idleTimer.unref()
    const encoded = texts.map((text) => Array.from(loaded.tokenizer.encode(text).ids).slice(0, MAX_TOKENS))
    const length = Math.max(1, ...encoded.map((ids) => ids.length))
    const ids = new BigInt64Array(texts.length * length)
    const mask = new BigInt64Array(texts.length * length)
    encoded.forEach((row, index) =>
      row.forEach((id, position) => {
        ids[index * length + position] = BigInt(id)
        mask[index * length + position] = 1n
      }),
    )
    const shape = [texts.length, length]
    const feeds: Record<string, unknown> = {
      input_ids: new loaded.ort.Tensor('int64', ids, shape),
      attention_mask: new loaded.ort.Tensor('int64', mask, shape),
    }
    if (loaded.session.inputNames.includes('token_type_ids')) {
      feeds['token_type_ids'] = new loaded.ort.Tensor('int64', new BigInt64Array(texts.length * length), shape)
    }
    const output = (await loaded.session.run(feeds))['last_hidden_state']
    if (output === undefined) throw new Error('模型没有输出向量。')
    const dimensions = output.dims[2] ?? 0
    return texts.map((_, index) => {
      const offset = index * length * dimensions
      const vector = Float32Array.from(output.data.subarray(offset, offset + dimensions))
      let norm = 0
      for (const value of vector) norm += value * value
      norm = Math.sqrt(norm) || 1
      for (let position = 0; position < vector.length; position++) vector[position] = vector[position]! / norm
      return vector
    })
  }

  async queryVector(text: string) {
    if (this.#mode !== 'builtin') return undefined
    if (this.#install.state !== 'installed') return { degraded: '内置语义模型还没有下载，这次只按关键词检索。' }
    if (this.#indexing.state !== 'ready') {
      const { documents, vectors } = this.#options.index.countIndexVectors(BUILTIN_SPACE)
      return { degraded: `语义索引正在建立（${vectors}/${documents}），这次只按关键词检索。` }
    }
    try {
      const [vector] = await this.embed([`${BUILTIN_EMBEDDING_MODEL.queryPrefix}${text}`])
      return { space: BUILTIN_SPACE, vector: vector! }
    } catch (error) {
      return {
        degraded: `语义模型暂时不可用（${error instanceof Error ? error.message : String(error)}），这次只按关键词检索。`,
      }
    }
  }

  /** Schedules a pass that gives every new or changed document a vector. */
  documentsChanged(): void {
    if (this.#mode !== 'builtin' || this.#install.state !== 'installed' || this.#disposed) return
    clearTimeout(this.#indexScheduled)
    this.#indexScheduled = setTimeout(() => {
      this.#indexRun ??= this.#indexPass().finally(() => {
        this.#indexRun = undefined
      })
    }, 1000)
    this.#indexScheduled.unref()
  }

  async #indexPass(): Promise<void> {
    if (this.#indexing.state !== 'ready') this.#indexing = { state: 'running' }
    this.#changed()
    try {
      let afterRowId = 0
      for (;;) {
        if (this.#disposed || this.#mode !== 'builtin') return
        const candidates = this.#options.index.listIndexEmbeddingCandidates(BUILTIN_SPACE, { afterRowId, limit: 64 })
        if (candidates.length === 0) break
        afterRowId = candidates.at(-1)!.rowId
        const stale = candidates
          .map((candidate) => ({ candidate, text: embeddingText(candidate.fields) }))
          .map((entry) => ({ ...entry, digest: embeddingTextDigest(entry.text) }))
          .filter(({ candidate, digest }) => candidate.vectorDigest !== digest)
        for (let start = 0; start < stale.length; start += EMBED_BATCH) {
          const batch = stale.slice(start, start + EMBED_BATCH)
          const vectors = await this.embed(batch.map(({ text }) => text || ' '))
          batch.forEach(({ candidate, digest }, index) => {
            const { vector, scale } = quantizeVector(vectors[index]!)
            this.#options.index.putIndexVector({
              rowId: candidate.rowId,
              space: BUILTIN_SPACE,
              vector,
              scale,
              textDigest: digest,
            })
          })
          this.#changed()
          // Leave room for conversations between batches.
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      }
      // Vectors of other models or templates are never compared with this space.
      this.#options.index.deleteIndexVectorsExcept([BUILTIN_SPACE])
      this.#indexing = { state: 'ready' }
    } catch (error) {
      this.#indexing = { state: 'idle', error: error instanceof Error ? error.message : String(error) }
    }
    this.#changed()
  }
}
