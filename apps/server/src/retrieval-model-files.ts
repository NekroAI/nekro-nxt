/**
 * Pinned files of the built-in retrieval model and its inference runtime (表情包与扩展素材能力 §6.4). Each entry is
 * `[path, bytes, sha256]`; a download that does not match is discarded.
 */
export type PinnedFile = readonly [path: string, bytes: number, sha256: string]

export const ONNXRUNTIME_VERSION = '1.30.0'

/** `onnxruntime-common`: the JavaScript API, shared by every platform. */
export const ONNXRUNTIME_COMMON_FILES: readonly PinnedFile[] = [
  ['dist/cjs/backend-impl.js', 5608, '3d25321895995f7e9480570b9a88f121049adf152e1829d0ecb11218da02d487'],
  ['dist/cjs/backend.js', 433, '325aaee7a2649ea27629666f3ca01c0d80b9751e704ce502e43a8352390749b4'],
  ['dist/cjs/env-impl.js', 969, '35cd8cac33973538eab471b68622c86c35a6896f4307d1a74c9ca0eda7abbac6'],
  ['dist/cjs/env.js', 366, '22c7647f8ca1c1b83b437a92b95fee1457fcb72866fa029616b8f146dc609be8'],
  ['dist/cjs/index.js', 1955, 'd7dd6cc9790e87299099fcd1b0ccb4969c01591d7eec0383a1c64dbea133dd1a'],
  ['dist/cjs/inference-session-impl.js', 8996, '88d90723a169297855ad3b564b134c6b685b2661316c81f71fc80da1e203bae0'],
  ['dist/cjs/inference-session.js', 467, '458be26f316c5068d32a56ddbc30ca0aa687c636e079b3d161a69f0f14a683f1'],
  ['dist/cjs/onnx-model.js', 211, '667f5fdac4b6df25e17f8a864d4dc619507f541f9fa0aafb6d3572fcca1e25e5'],
  ['dist/cjs/onnx-value.js', 211, '8446854766f4955ce438a7338216f49223767ecc508bb502b73a3dc1a1f1998e'],
  ['dist/cjs/tensor-conversion-impl.js', 8067, '9815e72c0bb91896035de93b3113a2256a1a998bc53c7b5e6bf5fb4e93714766'],
  ['dist/cjs/tensor-conversion.js', 218, '28cc462d4a9ea556ecc86c0e6d16a51d61b58d5bc5b4b7b48976b14bc8035bdc'],
  ['dist/cjs/tensor-factory-impl.js', 11656, 'a3204838a2c14416e4e61c968dc17c663ab3c9b8b2c4a8b7f2a1c5b06e3e5173'],
  ['dist/cjs/tensor-factory.js', 215, '13b8d735350b828a49bda8aeec50b1dac888cf42268006efc4312f50a88b6906'],
  ['dist/cjs/tensor-impl-type-mapping.js', 2995, '333110edbbffdb7575ea340cb341bcaf691862d6594a649db28097f7d8cb19b7'],
  ['dist/cjs/tensor-impl.js', 16458, '11645352ba5d08971344717d3339f86aac560f84f29229b2ebe07f1ec8aa8905'],
  ['dist/cjs/tensor-utils-impl.js', 2213, 'e7b1db989d33d54bdd1807b080a0989ff0b10d5f7dd8c93b92bbf293103aa4d5'],
  ['dist/cjs/tensor-utils.js', 213, 'd3f577e90dc2257c72ac728e5e6355c34af0342d971158d9f22b69d22aa97b8d'],
  ['dist/cjs/tensor.js', 393, '9097114de356750f36f28776fa6ccd08d13694f0f9aac9e7669c30b6c43153f7'],
  ['dist/cjs/trace.js', 2496, 'faecd0df94998d786e2085d56aa6003449f1ac3b35c350e0d2762498604e5d72'],
  ['dist/cjs/type-helper.js', 212, '7f786da8d2a611ad751c70a74edf4d9acfccd26be8e5c6b1cb730f982892bf32'],
  ['dist/cjs/version.js', 361, '0a1a7f532f4455ead0678966815c3114730150aa4368ebb5ebd9727425e9003b'],
  ['package.json', 977, '4266741a80346e25820ccc494fbffb95e2f652b6dfb5585025be44df3b0d6722'],
]

/** JavaScript of `onnxruntime-node`; it loads the native binding of the current platform. */
export const ONNXRUNTIME_NODE_FILES: readonly PinnedFile[] = [
  ['dist/index.js', 1602, '019eb02133b94b1f7fdf2d89eb93b590ce1288d271f7b280647fb3978e6391fa'],
  ['dist/version.js', 361, '0a1a7f532f4455ead0678966815c3114730150aa4368ebb5ebd9727425e9003b'],
  ['dist/backend.js', 6289, 'a79e8019e7276a282987023f9d38d41063a99e563e5e1a6f38a73a7d39ea83ab'],
  ['dist/binding.js', 1590, '2a85ac5de943c7222aae5ca2897f52d73891f528d4295b701fab077470c668c0'],
  ['package.json', 1593, '0871cd56ac2b9c9dfc834c7eabba819e5d4f966f005388515abb3402b14e0874'],
]

/** Native binding and libraries per `<platform>-<arch>`; Intel Macs have no official build. */
export const ONNXRUNTIME_NATIVE_FILES: Readonly<Record<string, readonly PinnedFile[]>> = {
  'darwin-arm64': [
    [
      'bin/napi-v6/darwin/arm64/onnxruntime_binding.node',
      266840,
      'a3f993357759b06ae2411f70af60f5e041d04521ea7f0d12cb7546e411a527dd',
    ],
    [
      'bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib',
      44589928,
      '685d2be5dba1309c89d3a5324b7fd06a5c42f1a61bfea32d14c4cc28d072121d',
    ],
  ],
  'linux-x64': [
    [
      'bin/napi-v6/linux/x64/onnxruntime_binding.node',
      389488,
      'ccdc60b981d93a490cf9513d3f583547252b6e285b72988a96a494f2f006c7b8',
    ],
    [
      'bin/napi-v6/linux/x64/libonnxruntime.so.1',
      45828512,
      'ffb75a925ba05e47b235bb66e3e3911714a80b328a9c9425539feb204aa32a23',
    ],
  ],
  'linux-arm64': [
    [
      'bin/napi-v6/linux/arm64/onnxruntime_binding.node',
      394648,
      'afec78dc11d38dc81605b068cefe1fc73ffe77ca240c15468aa40786150beac8',
    ],
    [
      'bin/napi-v6/linux/arm64/libonnxruntime.so.1',
      25135496,
      '1f549d46250b005580b597f4164984aaf75b3bcb9f3aeb07c7f8a8fe60b23c76',
    ],
  ],
  'win32-x64': [
    [
      'bin/napi-v6/win32/x64/onnxruntime_binding.node',
      298848,
      'ddd428464069b84414d34ec1796c7c2a69c33a976e4b0390692629e394f92fa1',
    ],
    [
      'bin/napi-v6/win32/x64/onnxruntime.dll',
      28754232,
      '508c362f5673483dd3a086379c392795b2e42d10d5e6f3f90ebd7ac21c97af67',
    ],
    [
      'bin/napi-v6/win32/x64/DirectML.dll',
      18527584,
      '234e8898778cdec88d3cb0539508273494082812c968699f3de665a018971625',
    ],
    [
      'bin/napi-v6/win32/x64/dxcompiler.dll',
      17986360,
      '593d42df78c7f9cbd97c1374af107cfe20985759f98b77afc1448fe41ee3cc76',
    ],
    ['bin/napi-v6/win32/x64/dxil.dll', 1508664, 'cf9a3981263f8ec30c9905d136eeaf4b4573209c602198671b958ec86905dea8'],
  ],
  'win32-arm64': [
    [
      'bin/napi-v6/win32/arm64/onnxruntime_binding.node',
      422200,
      'd8179924f15c2d3c1c8a75c50adf1671ec28c7f1cb0da9fc28b17daa02c5ecf5',
    ],
    [
      'bin/napi-v6/win32/arm64/onnxruntime.dll',
      29815136,
      '6c3a2abf5c6aca11c48a0d338a91af309f2266f25ce2e4084e6a87bbcb0fbfd0',
    ],
    [
      'bin/napi-v6/win32/arm64/DirectML.dll',
      18444600,
      'aaf72a9d55aa123e0708d957d30dd4fbeb7a2e335ec6257ed5ff4261a402b9ee',
    ],
    [
      'bin/napi-v6/win32/arm64/dxcompiler.dll',
      22285624,
      '442a995492579e1048cf1f05a86ab00f476c46b7f9d0996e588884040a543bbe',
    ],
    ['bin/napi-v6/win32/arm64/dxil.dll', 1769784, '859b6d638c5ca3df39e9cab2a602cb0f63d0e63d750f84bb2a9ec9031319b73e'],
  ],
}

/** npm CDNs that serve single files of a published package; jsDelivr refuses files this large. */
export const NPM_FILE_SOURCES: readonly ((name: string, version: string, file: string) => string)[] = [
  (name, version, file) => `https://registry.npmmirror.com/${name}/${version}/files/${file}`,
  (name, version, file) => `https://unpkg.com/${name}@${version}/${file}`,
]

export const BUILTIN_EMBEDDING_MODEL = {
  id: 'bge-small-zh-v1.5',
  repository: 'Xenova/bge-small-zh-v1.5',
  revision: '75c43b069aac4d136ba6bc1122f995fedcfd2781',
  dimensions: 512,
  /** Instruction BGE expects in front of short queries searching longer passages. */
  queryPrefix: '为这个句子生成表示以用于检索相关文章：',
  files: [
    ['onnx/model_quantized.onnx', 24010842, '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc'],
    ['tokenizer.json', 439125, '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26'],
    ['tokenizer_config.json', 367, 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a'],
  ] satisfies readonly PinnedFile[],
} as const

/** Hugging Face and its mirror, tried in order. */
export const MODEL_FILE_SOURCES: readonly ((repository: string, revision: string, file: string) => string)[] = [
  (repository, revision, file) => `https://huggingface.co/${repository}/resolve/${revision}/${file}`,
  (repository, revision, file) => `https://hf-mirror.com/${repository}/resolve/${revision}/${file}`,
]
