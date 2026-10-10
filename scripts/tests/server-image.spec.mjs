import assert from 'node:assert/strict'
import test from 'node:test'
import { assertServerImageIndex, serverArchitectureImage } from '../lib/server-image.mjs'

const digest = `sha256:${'a'.repeat(64)}`
const entry = (architecture, os = 'linux') => ({
  mediaType: 'application/vnd.oci.image.manifest.v1+json',
  digest: `sha256:${'b'.repeat(64)}`,
  platform: { os, architecture },
})
const index = (manifests) => ({ mediaType: 'application/vnd.oci.image.index.v1+json', digest, manifests })

test('a published Server image is an index carrying every Linux architecture', () => {
  assert.equal(assertServerImageIndex(index([entry('amd64'), entry('arm64')]), 'image'), digest)
  // Attestation entries carry an unknown platform and are not architectures.
  assert.equal(
    assertServerImageIndex(index([entry('amd64'), entry('arm64'), entry('unknown', 'unknown')]), 'image'),
    digest,
  )
  assert.equal(
    assertServerImageIndex(
      {
        ...index([entry('amd64'), entry('arm64')]),
        mediaType: 'application/vnd.docker.distribution.manifest.list.v2+json',
      },
      'image',
    ),
    digest,
  )
})

test('a single-architecture or incomplete Server image is refused', () => {
  assert.throws(() => assertServerImageIndex(index([entry('amd64')]), 'image'), /缺少架构：arm64/u)
  assert.throws(() => assertServerImageIndex(index([entry('arm64', 'windows'), entry('amd64')]), 'image'), /arm64/u)
  assert.throws(
    () => assertServerImageIndex({ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest }, 'image'),
    /不是多架构镜像/u,
  )
  assert.throws(() =>
    assertServerImageIndex({ ...index([entry('amd64'), entry('arm64')]), digest: 'sha256:1' }, 'image'),
  )
})

test('per-architecture candidates are named after the merged image', () => {
  assert.equal(
    serverArchitectureImage('ghcr.io/nekroai/nekro-nxt:preview-abc', 'arm64'),
    'ghcr.io/nekroai/nekro-nxt:preview-abc-arm64',
  )
})
