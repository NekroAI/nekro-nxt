import assert from 'node:assert/strict'
import test from 'node:test'
import { levelProblem, newestPublished, readLevel } from '../check-published-extension-sdk.mjs'
import { unpublishedProblem } from '../lib/npm-packages.mjs'

test('reads the level from source and from a bundled package', () => {
  assert.equal(readLevel('export const EXTENSION_SDK_LEVEL = 13\n'), 13)
  assert.equal(readLevel('var a=1;const EXTENSION_SDK_LEVEL=11;'), 11)
  assert.equal(readLevel('export const OTHER = 3'), undefined)
})

test('a Preview may ship a level npm already knows and waits for one it does not', () => {
  assert.equal(levelProblem({ local: 11, published: 11, publishedVersion: '0.5.0' }), undefined)
  assert.equal(levelProblem({ local: 11, published: 13, publishedVersion: '0.6.0' }), undefined)
  const problem = levelProblem({ local: 13, published: 11, publishedVersion: '0.5.0' })
  assert.match(problem ?? '', /本地扩展能力等级是 13，npm 上的 @nekro-nxt\/contracts 0\.5\.0 只到 11/u)
  assert.match(problem ?? '', /先发布共享包/u)
})

test('the level check reads the newer of next and latest', () => {
  assert.equal(newestPublished({ latest: '0.7.1' }), '0.7.1')
  assert.equal(newestPublished({ latest: '0.7.1', next: '0.8.0' }), '0.8.0')
  assert.equal(newestPublished({ latest: '0.10.0', next: '0.9.2' }), '0.10.0')
  assert.throws(() => newestPublished({}))
})

test('a stable release waits until every shared package version is on npm', () => {
  const published = { name: '@nekro-nxt/contracts', version: '0.8.1', published: true }
  assert.equal(unpublishedProblem([published]), undefined)
  const problem = unpublishedProblem([
    published,
    { name: '@nekro-nxt/extension-sdk', version: '0.7.2', published: false },
  ])
  assert.match(problem ?? '', /@nekro-nxt\/extension-sdk@0\.7\.2 还没有发布到 npm/u)
  assert.match(problem ?? '', /packages-v\* Tag/u)
  assert.doesNotMatch(problem ?? '', /contracts/u)
})
