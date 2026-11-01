import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { AddonGroup, AddonId, AddonProviderStatus, AddonState, AddonStatus, JsonValue } from '@nekro-nxt/contracts'
import type { CodeRunNode } from './code-run-node.js'
import type { GithubCli } from './github-cli.js'
import type { RetrievalRuntime } from './retrieval-runtime.js'
import type { RuntimeDownloadState } from './runtime-download.js'
import type { SpeechCloud } from './speech-cloud.js'
import type { LocalSpeech } from './speech-local.js'
import { LOCAL_SPEECH_MODELS, type LocalSpeechModelId } from './speech-model-files.js'
import type { VerificationBrowser } from './verification-browser.js'

/** Where a provider stands right now. */
export interface AddonProviderState {
  readonly state: AddonState
  readonly source?: AddonProviderStatus['source']
  readonly version?: string
  readonly downloadBytes?: number
  readonly memoryBytes?: number
  readonly progress?: AddonProviderStatus['progress']
  readonly error?: string
  readonly removable: boolean
}

/** One way to provide a capability (附加功能 F1): a bundled or system program, a download, a cloud service. */
export interface AddonProvider {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly licenses?: AddonProviderStatus['licenses']
  readonly sources?: readonly string[]
  /** Short differences worth comparing, such as languages or speed. */
  readonly notes?: readonly string[]
  /** Other capabilities it needs installed first. */
  readonly dependsOn?: readonly AddonId[]
  /** Executables it provides to commands and DSH plugins (附加功能 F4). */
  readonly programs?: readonly string[]
  /** Folders its own download occupies, measured for `installedBytes`. */
  readonly directories?: readonly string[]
  /** `undefined` leaves it out: a system program this device does not have, a bundled one this host lacks. */
  state(): AddonProviderState | undefined
  /** Starts installing; progress and the outcome arrive through `state()` and the capability's `subscribe()`. */
  install?(): void
  remove?(): Promise<void>
  /** Path of one of `programs`, while the provider is usable. */
  program?(name: string): string | undefined
}

/** One add-on: a capability with the providers people choose between, in order of preference. */
export interface AddonCapability {
  readonly id: AddonId
  readonly group: AddonGroup
  readonly title: string
  readonly summary: string
  readonly usedBy: readonly string[]
  readonly providers: readonly AddonProvider[]
  prepare?(): Promise<void>
  /** Hears any change of the providers' states. */
  subscribe?(listener: () => void): () => void
}

/** The provider a capability uses now. */
export interface ActiveAddonProvider {
  readonly id: string
  readonly source?: AddonProviderStatus['source']
  program(name: string): string | undefined
}

export interface AddonSettingsStore {
  get(key: string): { readonly value: JsonValue; readonly revision: number } | undefined
  put(key: string, value: JsonValue, expectedRevision: number | undefined): void
}

/** A request the registry refuses; `message` is shown to people as it is. */
export class AddonRequestError extends Error {
  constructor(
    readonly code:
      | 'addon-not-found'
      | 'addon-unsupported'
      | 'addon-not-installable'
      | 'addon-busy'
      | 'addon-not-removable'
      | 'addon-unavailable',
    message: string,
  ) {
    super(message)
  }
}

/** Bytes under `directory`, links not followed; a missing folder is empty. */
export const directoryBytes = async (directory: string): Promise<number> => {
  let entries: string[]
  try {
    const info = await lstat(directory)
    if (!info.isDirectory()) return info.size
    entries = await readdir(directory)
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) total += await directoryBytes(path.join(directory, entry))
  return total
}

const SETTING_KEY = 'addons'
const usable = (state: AddonState | undefined): boolean => state === 'installed' || state === 'available'

/**
 * Every add-on this host knows (附加功能 F1, F2) and which provider each one uses. The choice is stored as a system
 * setting; while the chosen provider cannot be used, the first usable one in declared order stands in. Listeners hear
 * only real changes of what `list()` returns, so a provider that reports often does not flood the snapshot.
 */
export class AddonRegistry {
  readonly #capabilities: ReadonlyMap<AddonId, AddonCapability>
  readonly #settings: AddonSettingsStore
  readonly #measure: (directory: string) => Promise<number>
  readonly #installedBytes = new Map<string, number>()
  readonly #measuring = new Set<string>()
  readonly #last = new Map<AddonId, string>()
  readonly #listeners = new Set<() => void>()
  readonly #unsubscribe: (() => void)[] = []

  constructor(
    capabilities: readonly AddonCapability[],
    options: { readonly settings: AddonSettingsStore; readonly measure?: (directory: string) => Promise<number> },
  ) {
    this.#capabilities = new Map(capabilities.map((capability) => [capability.id, capability]))
    this.#settings = options.settings
    this.#measure = options.measure ?? directoryBytes
    for (const capability of capabilities) {
      const unsubscribe = capability.subscribe?.(() => this.#changed(capability))
      if (unsubscribe !== undefined) this.#unsubscribe.push(unsubscribe)
    }
  }

  async prepare(): Promise<void> {
    const capabilities = [...this.#capabilities.values()]
    await Promise.all(capabilities.map((capability) => capability.prepare?.() ?? Promise.resolve()))
    await Promise.all(
      capabilities.flatMap((capability) =>
        capability.providers.map((provider) => this.#remeasure(capability, provider)),
      ),
    )
    for (const capability of capabilities) this.#last.set(capability.id, JSON.stringify(this.#status(capability)))
  }

  dispose(): void {
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe()
    this.#listeners.clear()
  }

  list(): AddonStatus[] {
    return [...this.#capabilities.values()].map((capability) => this.#status(capability))
  }

  status(id: AddonId): AddonStatus {
    return this.#status(this.#capability(id))
  }

  /** The provider `id` uses now, or `undefined` while none can be used. */
  active(id: AddonId): ActiveAddonProvider | undefined {
    const capability = this.#capabilities.get(id)
    const provider = capability === undefined ? undefined : this.#active(capability)
    if (provider === undefined) return undefined
    const source = provider.state()?.source
    return {
      id: provider.id,
      ...(source === undefined ? {} : { source }),
      program: (name) => provider.program?.(name),
    }
  }

  /** Installing a provider also selects it: whoever installs one means to use it. */
  install(id: AddonId, providerId: string): AddonStatus {
    const capability = this.#capability(id)
    const provider = this.#provider(capability, providerId)
    const state = provider.state()
    if (state?.state === 'unsupported') {
      throw new AddonRequestError('addon-unsupported', `这台设备不支持${provider.title}。`)
    }
    if (provider.install === undefined || state === undefined) {
      throw new AddonRequestError('addon-not-installable', `${provider.title}不需要安装。`)
    }
    this.#select(capability, provider.id)
    if (state.state !== 'installed' && state.state !== 'installing') provider.install()
    this.#publish(capability)
    return this.#status(capability)
  }

  async remove(id: AddonId, providerId: string): Promise<AddonStatus> {
    const capability = this.#capability(id)
    const provider = this.#provider(capability, providerId)
    const state = provider.state()
    if (state?.state === 'installing') {
      throw new AddonRequestError('addon-busy', `${provider.title}正在安装，完成后再删除。`)
    }
    if (provider.remove === undefined || state?.removable !== true) {
      throw new AddonRequestError('addon-not-removable', `${provider.title}不是 NekroNXT 下载的，不能在这里删除。`)
    }
    await provider.remove()
    this.#installedBytes.delete(`${id}/${provider.id}`)
    this.#publish(capability)
    return this.#status(capability)
  }

  select(id: AddonId, providerId: string): AddonStatus {
    const capability = this.#capability(id)
    const provider = this.#provider(capability, providerId)
    if (!usable(provider.state()?.state)) {
      throw new AddonRequestError('addon-unavailable', `${provider.title}还不能使用，先安装或配置。`)
    }
    this.#select(capability, provider.id)
    this.#publish(capability)
    return this.#status(capability)
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #capability(id: AddonId): AddonCapability {
    const capability = this.#capabilities.get(id)
    if (capability === undefined) throw new AddonRequestError('addon-not-found', '没有这项附加功能。')
    return capability
  }

  #provider(capability: AddonCapability, providerId: string): AddonProvider {
    const provider = capability.providers.find((candidate) => candidate.id === providerId)
    if (provider === undefined || provider.state() === undefined) {
      throw new AddonRequestError('addon-not-found', `${capability.title}没有这种提供方式。`)
    }
    return provider
  }

  #selection(): Record<string, string> {
    const value = this.#settings.get(SETTING_KEY)?.value
    const selection =
      typeof value === 'object' && value !== null && !Array.isArray(value) ? value['selection'] : undefined
    if (typeof selection !== 'object' || selection === null || Array.isArray(selection)) return {}
    return Object.fromEntries(
      Object.entries(selection).flatMap(([key, entry]) => (typeof entry === 'string' ? [[key, entry]] : [])),
    )
  }

  #select(capability: AddonCapability, providerId: string): void {
    const selection = { ...this.#selection(), [capability.id]: providerId }
    this.#settings.put(SETTING_KEY, { selection }, this.#settings.get(SETTING_KEY)?.revision)
  }

  #active(capability: AddonCapability): AddonProvider | undefined {
    const chosen = capability.providers.find((provider) => provider.id === this.#selection()[capability.id])
    if (chosen !== undefined && usable(chosen.state()?.state)) return chosen
    return capability.providers.find((provider) => usable(provider.state()?.state))
  }

  #status(capability: AddonCapability): AddonStatus {
    const providers = capability.providers.flatMap((provider) => {
      const state = provider.state()
      return state === undefined ? [] : [{ provider, state }]
    })
    const active = this.#active(capability)
    const chosen = providers.find(({ provider }) => provider.id === this.#selection()[capability.id])
    // While nothing can be used, show the install in progress, else the chosen one, else the first that could be.
    const shown =
      providers.find(({ provider }) => provider === active) ??
      providers.find(({ state }) => state.state === 'installing') ??
      chosen ??
      providers.find(({ state }) => state.state !== 'unsupported') ??
      providers[0]
    return {
      id: capability.id,
      group: capability.group,
      title: capability.title,
      summary: capability.summary,
      usedBy: [...capability.usedBy],
      state: shown?.state.state ?? 'unsupported',
      ...(shown?.state.progress === undefined ? {} : { progress: shown.state.progress }),
      ...(active === undefined ? {} : { selected: active.id }),
      providers: providers.map(({ provider, state }) => this.#providerStatus(capability, provider, state)),
    }
  }

  #providerStatus(
    capability: AddonCapability,
    provider: AddonProvider,
    state: AddonProviderState,
  ): AddonProviderStatus {
    const installedBytes =
      state.source === 'downloaded' ? this.#installedBytes.get(`${capability.id}/${provider.id}`) : undefined
    return {
      id: provider.id,
      title: provider.title,
      summary: provider.summary,
      state: state.state,
      ...(state.source === undefined ? {} : { source: state.source }),
      ...(state.version === undefined ? {} : { version: state.version }),
      resources: {
        ...(state.downloadBytes === undefined ? {} : { downloadBytes: state.downloadBytes }),
        ...(installedBytes === undefined ? {} : { installedBytes }),
        ...(state.memoryBytes === undefined ? {} : { memoryBytes: state.memoryBytes }),
        notes: [...(provider.notes ?? [])],
      },
      licenses: (provider.licenses ?? []).map((license) => ({ ...license })),
      sources: [...(provider.sources ?? [])],
      ...(state.progress === undefined ? {} : { progress: state.progress }),
      ...(state.error === undefined ? {} : { error: state.error }),
      installable: provider.install !== undefined && (state.state === 'not-installed' || state.state === 'failed'),
      removable: provider.remove !== undefined && state.removable,
    }
  }

  #changed(capability: AddonCapability): void {
    for (const provider of capability.providers) {
      const key = `${capability.id}/${provider.id}`
      const state = provider.state()
      // A finished install is measured once; a removed one forgets its size.
      if (state?.state !== 'installed' || state.source !== 'downloaded') this.#installedBytes.delete(key)
      else if (!this.#installedBytes.has(key)) {
        void this.#remeasure(capability, provider).then(() => this.#publish(capability))
      }
    }
    this.#publish(capability)
  }

  #publish(capability: AddonCapability): void {
    const next = JSON.stringify(this.#status(capability))
    if (this.#last.get(capability.id) === next) return
    this.#last.set(capability.id, next)
    for (const listener of this.#listeners) listener()
  }

  async #remeasure(capability: AddonCapability, provider: AddonProvider): Promise<void> {
    const key = `${capability.id}/${provider.id}`
    const state = provider.state()
    if (state?.state !== 'installed' || state.source !== 'downloaded' || this.#measuring.has(key)) return
    this.#measuring.add(key)
    try {
      let total = 0
      for (const directory of provider.directories ?? []) total += await this.#measure(directory)
      this.#installedBytes.set(key, total)
    } catch {
      // A size that cannot be read is left out.
    } finally {
      this.#measuring.delete(key)
    }
  }
}

/** A pinned download as a provider state; `found` is the downloaded program, if any. */
const downloadState = (
  download: RuntimeDownloadState | undefined,
  found: { readonly version?: string; readonly problem?: string } | undefined,
  options: { readonly version?: string; readonly downloadBytes?: number },
): AddonProviderState => {
  const size = options.downloadBytes === undefined ? {} : { downloadBytes: options.downloadBytes }
  if (download?.state === 'downloading') {
    return {
      state: 'installing',
      ...(options.version === undefined ? {} : { version: options.version }),
      ...size,
      progress: {
        receivedBytes: download.receivedBytes ?? 0,
        ...(download.totalBytes === undefined ? {} : { totalBytes: download.totalBytes }),
      },
      removable: false,
    }
  }
  if (found !== undefined) {
    const version = found.version ?? options.version
    return {
      state: found.problem === undefined ? 'installed' : 'failed',
      source: 'downloaded',
      ...(version === undefined ? {} : { version }),
      ...size,
      ...(found.problem === undefined ? {} : { error: found.problem }),
      removable: true,
    }
  }
  if (download === undefined) return { state: 'unsupported', removable: false }
  return {
    state: download.state === 'failed' ? 'failed' : 'not-installed',
    ...(options.version === undefined ? {} : { version: options.version }),
    ...size,
    ...(download.state === 'failed' ? { error: download.error ?? '安装失败。' } : {}),
    removable: false,
  }
}

const DOWNLOAD_SUMMARY = ''

export const nodeAddon = (node: CodeRunNode, directory: string): AddonCapability => {
  const downloadBytes = node.downloadBytes()
  return {
    id: 'node',
    group: 'agent',
    title: '编排运行环境',
    summary: '智能体用编排模式运行程序时需要。',
    usedBy: ['编排模式'],
    prepare: () => node.prepare(),
    subscribe: (listener) => node.subscribe(listener),
    providers: [
      {
        id: 'bundled',
        title: 'NekroNXT 自带的 Node',
        summary: '',
        programs: ['node'],
        state: () => {
          const bundled = node.bundled()
          return bundled && { state: 'available', source: 'bundled', version: bundled.version, removable: false }
        },
        program: (name) => (name === 'node' && node.bundled() !== undefined ? process.execPath : undefined),
      },
      {
        id: 'system',
        title: '这台设备的 Node',
        summary: '需要 Node 22 或更高版本。',
        programs: ['node'],
        state: () => {
          const system = node.system()
          return system && { state: 'available', source: 'system', version: system.version, removable: false }
        },
        program: (name) => (name === 'node' ? node.system()?.executable : undefined),
      },
      {
        id: 'download',
        title: '下载的 Node',
        summary: DOWNLOAD_SUMMARY,
        licenses: [{ component: 'Node.js', name: 'MIT', url: 'https://github.com/nodejs/node/blob/main/LICENSE' }],
        sources: ['nodejs.org'],
        programs: ['node'],
        directories: [directory],
        // The server runs programs with its own Node and offers no download.
        state: () =>
          node.embedded
            ? downloadState(node.download(), node.downloaded(), {
                version: node.releaseVersion,
                ...(downloadBytes === undefined ? {} : { downloadBytes }),
              })
            : undefined,
        install: () => node.startDownload(),
        remove: () => node.removeDownloaded(),
        program: (name) => (name === 'node' ? node.downloaded()?.executable : undefined),
      },
    ],
  }
}

export const githubCliAddon = (cli: GithubCli, directory: string): AddonCapability => {
  const downloadBytes = cli.downloadBytes()
  return {
    id: 'github-cli',
    group: 'agent',
    title: 'GitHub CLI',
    summary: '智能体在命令里用 gh 操作 GitHub。',
    usedBy: ['智能体命令'],
    prepare: () => cli.prepare(),
    subscribe: (listener) => cli.subscribe(listener),
    providers: [
      {
        id: 'system',
        title: '这台设备的 gh',
        summary: '',
        programs: ['gh'],
        state: () => {
          const system = cli.system()
          return system && { state: 'available', source: 'system', version: system.version, removable: false }
        },
        program: (name) => (name === 'gh' ? cli.system()?.executable : undefined),
      },
      {
        id: 'download',
        title: '下载的 gh',
        summary: DOWNLOAD_SUMMARY,
        licenses: [{ component: 'GitHub CLI', name: 'MIT', url: 'https://github.com/cli/cli/blob/trunk/LICENSE' }],
        sources: ['GitHub Releases'],
        programs: ['gh'],
        directories: [directory],
        state: () =>
          downloadState(cli.download(), cli.downloaded(), {
            version: cli.releaseVersion,
            ...(downloadBytes === undefined ? {} : { downloadBytes }),
          }),
        install: () => cli.startDownload(),
        remove: () => cli.removeDownloaded(),
        program: (name) => (name === 'gh' ? cli.downloaded()?.executable : undefined),
      },
    ],
  }
}

/** Chrome Headless Shell archives are 95–115 MB depending on the platform. */
const BROWSER_DOWNLOAD_BYTES = 110 * 1024 * 1024

export const browserAddon = (browser: VerificationBrowser, directory: string): AddonCapability => ({
  id: 'browser',
  group: 'host',
  title: '后台浏览器',
  summary: '没有打开 NekroNXT 页面时，检查智能体做的扩展界面。',
  usedBy: ['扩展界面检查'],
  prepare: () => browser.prepare(),
  subscribe: (listener) => browser.subscribe(listener),
  providers: [
    {
      id: 'bundled',
      title: '随 NekroNXT 安装的 Chromium',
      summary: '',
      state: () => {
        const executable = browser.bundled()
        if (executable === undefined) return undefined
        const problem = browser.problem(executable)
        return problem === undefined
          ? { state: 'available', source: 'bundled', removable: false }
          : { state: 'failed', source: 'bundled', error: problem, removable: false }
      },
      program: () => browser.bundled(),
    },
    {
      id: 'download',
      title: '下载的 Chromium',
      summary: DOWNLOAD_SUMMARY,
      licenses: [
        {
          component: 'Chromium',
          name: 'BSD-3-Clause',
          url: 'https://chromium.googlesource.com/chromium/src/+/main/LICENSE',
        },
      ],
      sources: ['Playwright（cdn.playwright.dev）'],
      directories: [directory],
      state: () => {
        const executable = browser.downloaded()
        const problem = executable === undefined ? undefined : browser.problem(executable)
        return downloadState(
          browser.download(),
          executable === undefined ? undefined : problem === undefined ? {} : { problem },
          { downloadBytes: BROWSER_DOWNLOAD_BYTES },
        )
      },
      install: () => browser.startDownload(),
      remove: () => browser.removeDownloaded(),
      program: () => browser.downloaded(),
    },
  ],
})

export const retrievalAddon = (retrieval: RetrievalRuntime): AddonCapability => ({
  id: 'retrieval',
  group: 'extension',
  title: '语义检索',
  summary: '按意思检索扩展保存的内容，例如表情包。',
  usedBy: ['扩展的检索'],
  subscribe: (listener) => retrieval.subscribe(listener),
  providers: [
    {
      id: 'bge-small-zh',
      title: '内置 bge-small-zh',
      summary: '在这台设备上运行的小型中文模型，内容不会发到别处。',
      licenses: [
        { component: 'bge-small-zh-v1.5', name: 'MIT', url: 'https://huggingface.co/BAAI/bge-small-zh-v1.5' },
        { component: 'ONNX Runtime', name: 'MIT', url: 'https://github.com/microsoft/onnxruntime/blob/main/LICENSE' },
      ],
      sources: ['Hugging Face', 'hf-mirror.com', 'npmmirror', 'unpkg'],
      get directories() {
        return retrieval.installation().directories
      },
      state: () => {
        const { model, supported, downloadBytes, install } = retrieval.installation()
        if (install.state === 'installed') {
          return { state: 'installed', source: 'downloaded', version: model, downloadBytes, removable: true }
        }
        if (!supported) return { state: 'unsupported', downloadBytes, removable: false }
        if (install.state === 'downloading') {
          return {
            state: 'installing',
            downloadBytes,
            progress: { receivedBytes: install.receivedBytes, totalBytes: install.totalBytes },
            removable: false,
          }
        }
        if (install.state === 'failed') {
          return { state: 'failed', downloadBytes, error: install.error, removable: false }
        }
        return { state: 'not-installed', downloadBytes, removable: false }
      },
      install: () => retrieval.startDownload(),
      remove: () => retrieval.remove(),
    },
  ],
})

const SHERPA_LICENSES: AddonProviderStatus['licenses'] = [
  { component: 'sherpa-onnx', name: 'Apache-2.0', url: 'https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE' },
  { component: 'Silero VAD', name: 'MIT', url: 'https://github.com/snakers4/silero-vad/blob/master/LICENSE' },
]

const localSpeechProvider = (
  local: LocalSpeech,
  id: LocalSpeechModelId,
  describe: Pick<AddonProvider, 'title' | 'notes' | 'licenses'>,
): AddonProvider => ({
  id,
  ...describe,
  summary: '在这台设备上识别，语音不会发到别处。',
  sources: ['npm', 'npmmirror', 'Hugging Face', 'hf-mirror.com', 'GitHub Releases'],
  directories: local.directories(id),
  state: () => {
    const { name: version, memoryBytes } = LOCAL_SPEECH_MODELS[id]
    const install = local.install(id)
    const base = { version, memoryBytes, downloadBytes: local.downloadBytes(id) }
    if (install.state === 'installed') return { ...base, state: 'installed', source: 'downloaded', removable: true }
    if (!local.supported) return { ...base, state: 'unsupported', removable: false }
    if (install.state === 'downloading') {
      return {
        ...base,
        state: 'installing',
        progress: { receivedBytes: install.receivedBytes, totalBytes: install.totalBytes },
        removable: false,
      }
    }
    if (install.state === 'failed') return { ...base, state: 'failed', error: install.error, removable: false }
    return { ...base, state: 'not-installed', removable: false }
  },
  install: () => local.startDownload(id),
  remove: () => local.remove(id),
})

/** Speech recognition (附加功能 F9): two local models sharing one runtime, and the cloud. */
export const speechAddon = (local: LocalSpeech, cloud: SpeechCloud): AddonCapability => ({
  id: 'speech',
  group: 'extension',
  title: '语音识别',
  summary: '把语音转成文字。',
  usedBy: ['扩展的语音识别'],
  prepare: () => local.prepare(),
  subscribe: (listener) => {
    const unsubscribe = [local.subscribe(listener), cloud.subscribe(listener)]
    return () => unsubscribe.forEach((stop) => stop())
  },
  providers: [
    localSpeechProvider(local, 'paraformer-zh-small', {
      title: '本地 Paraformer',
      notes: ['中文', '识别更快'],
      licenses: SHERPA_LICENSES,
    }),
    localSpeechProvider(local, 'sense-voice-small', {
      title: '本地 SenseVoice',
      notes: ['中文、英语、日语、韩语、粤语'],
      licenses: [
        ...SHERPA_LICENSES,
        {
          component: 'SenseVoice-Small',
          name: 'FunASR Model License',
          url: 'https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE',
        },
        { component: 'WSYue-ASR', name: 'Apache-2.0', url: 'https://huggingface.co/ASLP-lab/WSYue-ASR' },
      ],
    }),
    {
      id: 'cloud',
      title: '云端',
      summary: '用「设置 → 模型」里的供应商识别，按供应商的价格计费。',
      notes: ['语言和速度取决于供应商'],
      state: () => ({
        state: cloud.settings() === undefined ? 'needs-config' : 'available',
        source: 'cloud',
        removable: false,
      }),
    },
  ],
})
