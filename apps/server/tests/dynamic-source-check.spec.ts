import { describe, expect, it } from 'vitest'
import { checkDynamicHostSource } from '../src/dynamic-source-check.js'
import { strayErrorMessage, strayErrorSource } from '../src/extension-stray-errors.js'

describe('dynamic Host source check', () => {
  it('refuses import() and an undeclared require() with the line and what to use instead', () => {
    expect(() => checkDynamicHostSource(`const a = 1\nimport('node:crypto').then(() => a)\nreturn {}`)).toThrow(
      /import\(\)（第 2 行）.*crypto\.getRandomValues/u,
    )
    expect(() => checkDynamicHostSource(`const fs = require('node:fs')\nreturn {}`)).toThrow(/require\(\)（第 1 行）/u)
  })

  it('checks a whole module after stripping its types, without line numbers', () => {
    const module = `import { defineHostExtension } from '@nekro-nxt/extension-sdk'
const load = async (): Promise<unknown> => import('node:crypto')
export default defineHostExtension(() => ({ apply() { void load } }))`
    expect(() => checkDynamicHostSource(module, 'module')).toThrow(/用了 import\(\)。/u)
    expect(
      checkDynamicHostSource(
        `import { defineHostExtension } from '@nekro-nxt/extension-sdk'\nexport default defineHostExtension(() => ({}))`,
        'module',
      ),
    ).toEqual({ notes: [] })
  })

  it('ignores the same words in comments, strings, property names and code that declares them itself', () => {
    const source = `// import('x') and require('y') in a comment
const text = "import('x') require('y') process Buffer"
const template = \`call require(\${1}) later\`
const loader = { require: (name) => name, process: 1 }
loader.require('z')
const fn = (require) => require('w')
const performance = { now: () => 0 }
performance.now()
if (typeof process !== 'undefined') loader.process += 1
return { text, template }`
    expect(checkDynamicHostSource(source)).toEqual({ notes: [] })
  })

  it('notes globals the sandbox lacks but still lets the candidate be defined', () => {
    expect(
      checkDynamicHostSource(`const id = Buffer.from('a').toString('hex')\nreturn { id, env: process.env }`),
    ).toEqual({
      notes: [
        'Host 源码用了 process（第 2 行），试运行环境里没有它：进程信息和环境变量拿不到，配置项用 harness.config() 或 ctx.config() 读取。',
        'Host 源码用了 Buffer（第 1 行），试运行环境里没有它：二进制数据用 Uint8Array，base64 用 btoa / atob。',
      ],
    })
  })

  it('leaves code that does not parse to the runner, which reports the line', () => {
    expect(checkDynamicHostSource('return { apply( {')).toEqual({ notes: [] })
  })
})

describe('stray extension errors', () => {
  it('finds the candidate or saved version on the stack and words the import failure for the agent', () => {
    const at = (frame: string) => Object.assign(new Error('失败'), { stack: `Error: 失败\n    at ${frame}` })
    expect(strayErrorSource(at('cordis-dyn-draw-1.js:139:3'))).toEqual({ kind: 'candidate', pluginId: 'draw-1' })
    expect(
      strayErrorSource(at('file:///data/extension-cache/xrv_01M4FEYTW44A96EA6JYR6RBJG8/abc/host.mjs?build=1:2:3')),
    ).toEqual({ kind: 'revision', revisionId: 'xrv_01M4FEYTW44A96EA6JYR6RBJG8' })
    expect(
      strayErrorSource(at('C:\\data\\extension-cache\\xrv_01M4FEYTW44A96EA6JYR6RBJG8\\abc\\host.mjs:2:3')),
    ).toEqual({
      kind: 'revision',
      revisionId: 'xrv_01M4FEYTW44A96EA6JYR6RBJG8',
    })
    expect(strayErrorSource(at('file:///app/server/index.js:1:1'))).toBeUndefined()
    expect(strayErrorSource('不是错误')).toBeUndefined()
    expect(
      strayErrorMessage(Object.assign(new TypeError('x'), { code: 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING' })),
    ).toBe('动态扩展不能用 import() 加载模块')
  })
})
