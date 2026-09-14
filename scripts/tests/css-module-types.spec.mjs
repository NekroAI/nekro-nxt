import assert from 'node:assert/strict'
import test from 'node:test'
import { cssModuleDeclaration } from '../lib/css-module-types.mjs'

test('CSS types use class selectors, not comments, strings, URLs or global selectors', () => {
  const result = cssModuleDeclaration(
    `/* .comment */\n.real, .second:hover { content: '.string'; background: url('https://example.test/icon.png'); }\n@media (width > 10px) { .nested > :global(.foreign) { color: red; } }\n[data-label='.attribute'] { color: blue }`,
  )
  for (const name of ['real', 'second', 'nested']) assert.match(result, new RegExp(`readonly ${name}: string`))
  for (const name of ['comment', 'string', 'test', 'png', 'foreign', 'attribute'])
    assert.ok(!result.includes(`readonly ${name}:`))
})
