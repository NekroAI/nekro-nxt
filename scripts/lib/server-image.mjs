import { spawnSync } from 'node:child_process'

/** Every Server image is published for these Linux architectures, each built on a native runner. */
export const SERVER_IMAGE_ARCHITECTURES = Object.freeze(['amd64', 'arm64'])

/** The per-architecture candidate pushed by one build job; the merge job lists them under `image`. */
export const serverArchitectureImage = (image, architecture) => `${image}-${architecture}`

const INDEX_MEDIA_TYPES = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
])

/**
 * Checks the top-level manifest of a published Server image: a multi-architecture index carrying every Linux
 * architecture in `SERVER_IMAGE_ARCHITECTURES`. Entries without a Linux platform (attestations) are ignored.
 */
export function assertServerImageIndex(manifest, reference) {
  if (!INDEX_MEDIA_TYPES.has(manifest?.mediaType) || !/^sha256:[a-f0-9]{64}$/u.test(manifest.digest ?? '')) {
    throw new Error(`${reference} 不是多架构镜像。`)
  }
  const architectures = new Set(
    (manifest.manifests ?? [])
      .filter((entry) => entry?.platform?.os === 'linux')
      .map((entry) => entry.platform.architecture),
  )
  const missing = SERVER_IMAGE_ARCHITECTURES.filter((architecture) => !architectures.has(architecture))
  if (missing.length > 0) throw new Error(`${reference} 缺少架构：${missing.join(', ')}`)
  return manifest.digest
}

const docker = (args) => {
  const result = spawnSync('docker', args, { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(' ')} 执行失败：${result.stderr.trim()}`)
  return result.stdout.trim()
}

/** The registry's top-level manifest descriptor for `reference`, read without pulling any layer. */
export const readManifest = (reference) =>
  JSON.parse(docker(['buildx', 'imagetools', 'inspect', reference, '--format', '{{json .Manifest}}']))

export const manifestDigest = (reference) => {
  const digest = readManifest(reference).digest
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest ?? '')) throw new Error(`无法读取 ${reference} 的镜像摘要。`)
  return digest
}

export const serverImageDigest = (reference) => assertServerImageIndex(readManifest(reference), reference)

/**
 * Points every tag at `source` inside the registries. An index is copied byte for byte, so each tag keeps the
 * source digest; a single-architecture source is wrapped in a new index (only old images are like that).
 */
export const copyImage = (source, tags) => {
  if (tags.length === 0) return
  docker(['buildx', 'imagetools', 'create', ...tags.flatMap((tag) => ['--tag', tag]), source])
}

/** Merges the per-architecture candidates of `image` into one index under `image` and returns its digest. */
export function mergeServerImage(image) {
  docker([
    'buildx',
    'imagetools',
    'create',
    '--tag',
    image,
    ...SERVER_IMAGE_ARCHITECTURES.map((architecture) => serverArchitectureImage(image, architecture)),
  ])
  return serverImageDigest(image)
}
