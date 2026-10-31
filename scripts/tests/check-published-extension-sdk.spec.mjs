import assert from 'node:assert/strict'
import test from 'node:test'
import { levelProblem, readLevel } from '../check-published-extension-sdk.mjs'

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
