import assert from 'node:assert/strict'
import test from 'node:test'
import { hasPreviewProductChanges, publishedPreviewCommit } from '../lib/preview-changes.mjs'
import { assertServerPreviewReceipt, publishPreviewTransaction } from '../rolling-preview-release.mjs'

test('Preview includes all unpublished product changes and conservatively includes unknown paths', () => {
  assert.equal(hasPreviewProductChanges(['docs/guide/a.md', 'apps/web/tests/a.spec.ts']), false)
  assert.equal(hasPreviewProductChanges(['docs/guide/a.md', 'apps/web/src/app.tsx']), true)
  for (const file of [
    'pnpm-lock.yaml',
    'scripts/release-desktop.mjs',
    'packages/new/runtime.md',
    'new-path/file',
    'assets/brand/icon.svg',
  ])
    assert.equal(hasPreviewProductChanges([file]), true)
  const commit = 'a'.repeat(40)
  assert.equal(publishedPreviewCommit({ draft: false, body: `<!-- nxt-preview-commit:${commit} -->` }), commit)
  assert.equal(publishedPreviewCommit({ draft: true, body: `<!-- nxt-preview-commit:${commit} -->` }), undefined)
})

test('stale Preview never uploads and invalidation during upload cleans only its candidates', async () => {
  const events = []
  let checks = 0
  const ports = {
    isCurrent: () => ++checks === 1,
    upload: () => {
      events.push('upload')
    },
    publish: () => {
      events.push('publish')
    },
    rollback: () => {
      events.push('rollback')
    },
    cleanupCandidate: () => {
      events.push('cleanup')
    },
  }
  assert.equal(await publishPreviewTransaction({ ...ports, isCurrent: () => false }), false)
  assert.deepEqual(events, [])
  assert.equal(await publishPreviewTransaction(ports), false)
  assert.deepEqual(events, ['upload', 'cleanup'])
})

test('Preview failures restore the previous publication before cleaning candidates', async () => {
  for (const failAt of ['upload', 'publish']) {
    const events = []
    const operation = (stage) => () => {
      events.push(stage)
      if (stage === failAt) throw new Error(stage)
    }
    await assert.rejects(
      publishPreviewTransaction({
        isCurrent: () => true,
        upload: operation('upload'),
        publish: operation('publish'),
        rollback: operation('rollback'),
        cleanupCandidate: operation('cleanup'),
      }),
      new RegExp(failAt),
    )
    assert.deepEqual(
      events,
      failAt === 'upload' ? ['upload', 'rollback', 'cleanup'] : ['upload', 'publish', 'rollback', 'cleanup'],
    )
  }
})

test('successful Preview publishes once after upload and checks Server digest and commit', async () => {
  const events = []
  assert.equal(
    await publishPreviewTransaction({
      isCurrent: () => true,
      upload: () => {
        events.push('upload')
      },
      publish: () => {
        events.push('publish')
      },
      rollback: () => {
        throw new Error('unexpected rollback')
      },
      cleanupCandidate: () => {
        throw new Error('unexpected cleanup')
      },
    }),
    true,
  )
  assert.deepEqual(events, ['upload', 'publish'])
  const release = { commit: 'a'.repeat(40), releaseId: 'test' }
  const receipt = {
    ...release,
    image: `ghcr.io/nekroai/nekro-nxt:preview-${release.commit}`,
    digest: `sha256:${'b'.repeat(64)}`,
  }
  assert.doesNotThrow(() => assertServerPreviewReceipt(receipt, release, 'NekroAI/nekro-nxt'))
  assert.throws(() => assertServerPreviewReceipt({ ...receipt, commit: 'c'.repeat(40) }, release, 'NekroAI/nekro-nxt'))
})
