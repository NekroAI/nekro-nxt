import assert from 'node:assert/strict'
import { test } from 'node:test'
import postcss from 'postcss'
import { themeTransitions } from '../theme-transitions.mjs'

const compile = async (source, from = '/fixture/apps/web/src/surface.module.css') =>
  (await postcss([themeTransitions()]).process(source, { from })).root

test('theme ownership follows real surfaces, not layout or inherited text rules', async () => {
  const root = await compile(
    '.layout { display: flex } .text { color: inherit } .surface { color: var(--nxt-text-primary); background: var(--nxt-bg-surface) }',
  )
  const owners = []
  root.walkDecls('transition', (decl) => {
    assert.equal(decl.parent?.type, 'rule')
    if (decl.parent?.type === 'rule') owners.push(decl.parent.selector)
  })
  assert.deepEqual(owners, [':global(:root[data-theme-changing]) :where(.surface)'])
})

test('theme marking preserves pseudo elements, media context and existing hover transitions', async () => {
  const root = await compile(
    '@media (min-width: 800px) { .button:hover::before { background: var(--nxt-accent); transition: transform 120ms ease } }',
  )
  const original = []
  root.walkDecls('transition', (decl) => {
    original.push(decl.value)
  })
  assert.deepEqual(original, ['transform 120ms ease', 'var(--nxt-theme-transition)'])
  root.walkDecls('transition', (decl) => {
    if (decl.value !== 'var(--nxt-theme-transition)') return
    assert.ok(decl.parent?.type === 'rule')
    assert.equal(decl.parent.selector, ':global(:root[data-theme-changing]) :where(.button:hover)::before')
    assert.ok(decl.parent.parent?.type === 'atrule')
    assert.equal(decl.parent.parent.params, '(min-width: 800px)')
  })
})

test('theme marking does not alter animation keyframes or third-party styles', async () => {
  const animation = '@keyframes flash { from { color: red } to { color: blue } }'
  assert.equal((await compile(animation)).toString(), animation)
  const external = '.extension { color: red }'
  assert.equal((await compile(external, '/fixture/node_modules/package/style.css')).toString(), external)
})
