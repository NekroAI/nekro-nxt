import { transformSync } from 'esbuild'

const SDK_SHIM = `{ defineHostExtension: (factory) => factory, defineClientExtension: (factory) => factory }`

/**
 * Turns a whole extension module (as imported or hand-written extensions are stored) into the factory body a dynamic
 * run executes. TypeScript is stripped, the SDK import resolves to the identity helpers, a CSS Module import resolves
 * to nothing (the run injects scoped CSS itself), and anything else is refused like the saved-Revision builder does.
 * The saved Revision keeps the module unchanged.
 */
export const moduleToFactoryBody = (source: string, half: 'host' | 'client'): string => {
  let compiled: string
  try {
    compiled = transformSync(source, {
      loader: 'ts',
      format: 'cjs',
      target: 'es2022',
      sourcefile: `${half}.ts`,
    }).code
  } catch (error) {
    throw new Error(`扩展源码无法解析：${error instanceof Error ? error.message : String(error)}`)
  }
  const environment =
    half === 'host' ? '{ harness, nxt, logger: typeof logger === "undefined" ? undefined : logger }' : '{ React, host, styles }'
  return `const __nxtModule = { exports: {} }
const __nxtRequire = (name) => {
  if (name === '@nekro-nxt/extension-sdk') return ${SDK_SHIM}
  if (/\\.css(\\?.*)?$/u.test(name)) return {}
  throw new Error('扩展不能导入 ' + name + '，只能使用 @nekro-nxt/extension-sdk。')
}
;((module, exports, require) => {
${compiled}
})(__nxtModule, __nxtModule.exports, __nxtRequire)
const __nxtFactory = __nxtModule.exports.default ?? __nxtModule.exports
if (typeof __nxtFactory !== 'function') throw new Error('扩展模块必须默认导出 define${half === 'host' ? 'Host' : 'Client'}Extension(...) 的结果。')
return await __nxtFactory(${environment})`
}
