import type { PinnedFile } from './retrieval-model-files.js'

/**
 * Pinned downloads of local speech recognition (附加功能 F9, F15): the sherpa-onnx runtime from npm, Silero VAD and two
 * recognition models from Hugging Face. A download that does not match its size and sha256 is discarded.
 */
export const SHERPA_ONNX_VERSION = '2.0.1'

/** An npm package tarball, `[name, bytes, sha256]`. */
export type PinnedPackage = readonly [name: string, bytes: number, sha256: string]

/** The JavaScript API; it loads the native package of the current platform from a sibling folder. */
export const SHERPA_ONNX_NODE: PinnedPackage = [
  'sherpa-onnx-node',
  12709,
  '06ef8dfb9ea0f3cc77c1866620cbe05bf11b7dd70a973a454b77ce4a66cbcee1',
]

/** Native packages per `<platform>-<arch>`; each carries its own onnxruntime. */
export const SHERPA_ONNX_NATIVE: Readonly<Record<string, PinnedPackage>> = {
  'darwin-arm64': [
    'sherpa-onnx-darwin-arm64',
    10013200,
    'afc9415260e232c4dadc25a29a8645acb0ba06ef989060d32274f4c749a4830e',
  ],
  'darwin-x64': [
    'sherpa-onnx-darwin-x64',
    11167483,
    'e95e4addd3d02919ae61f311effd6e5349e00b50985c4a8c9a3bcb03dc6d6325',
  ],
  'linux-arm64': [
    'sherpa-onnx-linux-arm64',
    13822449,
    'b8f18ee34c8e14bbafb7f51332361a6ab91f4ddbb4a4eac58f74ec0dafb39e87',
  ],
  'linux-x64': ['sherpa-onnx-linux-x64', 11005484, '08c6fe2b65838febbd0c260aaa9991990d2d592e503e758bfd2f5db6cbc79338'],
  'win32-arm64': ['sherpa-onnx-win-arm64', 8486399, '5ea165239cb9ac3ddc3e91b74ea54aeb8a3145e7006e0cba57c5b62b58b9e3dc'],
  'win32-x64': ['sherpa-onnx-win-x64', 8779375, '217cec234c6026dbfd2b9c06523507180796fe4227c7cc9d11cfe218260a2519'],
}

/** npmmirror does not serve single files of these packages, so whole tarballs are fetched. */
export const NPM_TARBALL_SOURCES: readonly ((name: string, version: string) => string)[] = [
  (name, version) => `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
  (name, version) => `https://registry.npmmirror.com/${name}/-/${name}-${version}.tgz`,
]

/** Silero VAD v5; Hugging Face and its mirror first, then the sherpa-onnx release that publishes the same file. */
export const SILERO_VAD = {
  repository: 'csukuangfj/vad',
  revision: 'fba88cd2e921609e7675c3aaf51e0b9b295da4bc',
  file: ['silero_vad_v5.onnx', 2313101, '6b99cbfd39246b6706f98ec13c7c50c6b299181f2474fa05cbc8046acc274396'],
  release: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad_v5.onnx',
} as const

export type LocalSpeechModelId = 'paraformer-zh-small' | 'sense-voice-small'

export interface LocalSpeechModel {
  readonly id: LocalSpeechModelId
  /** Which sherpa-onnx recognizer runs it. */
  readonly kind: 'paraformer' | 'sense-voice'
  /** Reported with every transcript. */
  readonly name: string
  readonly repository: string
  readonly revision: string
  /** The model, then its tokens. */
  readonly files: readonly [model: PinnedFile, tokens: PinnedFile]
  /** Resident memory of the engine with this model loaded, measured on Apple Silicon. */
  readonly memoryBytes: number
}

const MB = 1024 * 1024

export const LOCAL_SPEECH_MODELS: Readonly<Record<LocalSpeechModelId, LocalSpeechModel>> = {
  'paraformer-zh-small': {
    id: 'paraformer-zh-small',
    kind: 'paraformer',
    name: 'paraformer-zh-small-int8',
    repository: 'csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09',
    revision: '63ddc3cd0f2810b68289a7b3876e62ef5d53d6df',
    files: [
      ['model.int8.onnx', 81828675, '3ef6c19369b912f7caf3cef8e545c5ccd1a33d9d7ec792a46668dc41c4b229ec'],
      ['tokens.txt', 75352, '4b2d964e18b9cf139b473003b6698fb2ed9a2a5ec55b93daa677b28f578897aa'],
    ],
    memoryBytes: 350 * MB,
  },
  'sense-voice-small': {
    id: 'sense-voice-small',
    kind: 'sense-voice',
    name: 'sense-voice-small-int8',
    repository: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    revision: '2365baeacb507f821a0c8120fcee3d484dba7a07',
    files: [
      ['model.int8.onnx', 239233841, 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51'],
      ['tokens.txt', 315894, 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc'],
    ],
    memoryBytes: 900 * MB,
  },
}
