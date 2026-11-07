import { moduleSourceAsJavaScript } from '@nekro-nxt/extension-runtime'
import { parse, type AnyNode, type Pattern } from 'acorn'

/** What a dynamic run's Host half should use instead of loading modules, said once for both refusals. */
const REPLACEMENTS =
  '随机数和编号用 crypto.getRandomValues / crypto.randomUUID，网址用 URL / URLSearchParams，网络请求用 ctx.nxt.http.fetch，文件用 ctx.nxt.files。'

/**
 * Globals a saved extension has but the DSH sandbox does not, and that the dynamic wrapper does not supply either.
 * `require`, `fetch` and `setImmediate` are left out of the define-time notes: the sandbox traps them when called.
 */
const MISSING_GLOBALS: Readonly<Record<string, string>> = {
  process: '进程信息和环境变量拿不到，配置项用 harness.config() 或 ctx.config() 读取',
  Buffer: '二进制数据用 Uint8Array，base64 用 btoa / atob',
  performance: '计时用 Date.now()',
  queueMicrotask: '改用 await Promise.resolve()',
}

/** Sandbox traps for these throw `<name> is not available in the dynamic package sandbox — …` when called. */
const TRAPPED_GLOBALS: Readonly<Record<string, string>> = {
  require: '要用的能力都在 harness、ctx 和 ctx.nxt 上，网络请求用 ctx.nxt.http.fetch，文件用 ctx.nxt.files',
  fetch: '网络请求用 ctx.nxt.http.fetch',
  setImmediate: '改用 setTimeout(fn, 0)',
}

export interface SandboxGap {
  readonly name: string
  /** What the agent is told: the trial-run environment has no `name`, and what to use instead. */
  readonly message: string
}

/**
 * Recognizes a failure caused only by a global the trial-run sandbox lacks but a saved extension has. The code is not
 * wrong for a saved extension, so the authoring breaker does not count it; the agent is told what to use instead.
 * Only the known names above match, so a typo such as `procss is not defined` stays an ordinary failure.
 */
export const sandboxGapOf = (message: string): SandboxGap | undefined => {
  const missing = /\b([A-Za-z]+) is not defined\b/u.exec(message)?.[1]
  const trapped = /\b([A-Za-z]+) is not available in the dynamic package sandbox\b/u.exec(message)?.[1]
  const name =
    missing !== undefined && Object.hasOwn(MISSING_GLOBALS, missing)
      ? missing
      : trapped !== undefined && Object.hasOwn(TRAPPED_GLOBALS, trapped)
        ? trapped
        : undefined
  if (name === undefined) return undefined
  const instead = MISSING_GLOBALS[name] ?? TRAPPED_GLOBALS[name]
  return {
    name,
    message: `试运行环境里没有 ${name}，保存后的扩展才有：${instead}。改好后重新运行。原始错误：${message}`,
  }
}

export interface DynamicSourceFindings {
  /** Shown to the agent with the definition; the candidate is still defined. */
  readonly notes: readonly string[]
}

const isNode = (value: unknown): value is AnyNode =>
  typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'

/** Child nodes in source order, whatever the node type. */
const children = (node: AnyNode): AnyNode[] =>
  Object.entries(node).flatMap(([key, value]: [string, unknown]) => {
    if (key === 'loc') return []
    if (Array.isArray(value)) return value.filter(isNode)
    return isNode(value) ? [value] : []
  })

/** Names bound by a declaration pattern (`a`, `{ a, b: [c] }`, `...d`, `e = 1`). */
const patternNames = (pattern: Pattern | null | undefined, into: Set<string>): void => {
  if (!pattern) return
  switch (pattern.type) {
    case 'Identifier':
      into.add(pattern.name)
      return
    case 'ObjectPattern':
      for (const property of pattern.properties) {
        patternNames(property.type === 'RestElement' ? property.argument : property.value, into)
      }
      return
    case 'ArrayPattern':
      for (const element of pattern.elements) patternNames(element, into)
      return
    case 'AssignmentPattern':
      patternNames(pattern.left, into)
      return
    case 'RestElement':
      patternNames(pattern.argument, into)
      return
    case 'MemberExpression':
      // An assignment target such as `a.b = 1` declares nothing.
      return
  }
}

/**
 * Every name the source declares anywhere. Scopes are not tracked: a name declared anywhere counts as the source's
 * own, which can only miss a finding, never invent one.
 */
const declaredNames = (root: AnyNode): Set<string> => {
  const names = new Set<string>()
  const visit = (node: AnyNode): void => {
    if (node.type === 'VariableDeclarator') patternNames(node.id, names)
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') patternNames(node.id, names)
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      for (const param of node.params) patternNames(param, names)
    }
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') patternNames(node.id, names)
    if (node.type === 'CatchClause') patternNames(node.param, names)
    if (
      node.type === 'ImportSpecifier' ||
      node.type === 'ImportDefaultSpecifier' ||
      node.type === 'ImportNamespaceSpecifier'
    ) {
      patternNames(node.local, names)
    }
    for (const child of children(node)) visit(child)
  }
  visit(root)
  return names
}

/** Child nodes that are names rather than variable reads: property names, object keys and labels. */
const nameChildren = (node: AnyNode): Set<AnyNode> => {
  if (node.type === 'MemberExpression') return new Set(node.computed ? [] : [node.property])
  // A shorthand `{ a }` reads `a` through its value, which is the same node as its key.
  if (node.type === 'Property') return new Set(node.computed || node.shorthand ? [] : [node.key])
  if (node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') {
    return new Set(node.computed ? [] : [node.key])
  }
  if (node.type === 'LabeledStatement') return new Set([node.label])
  if (node.type === 'BreakStatement' || node.type === 'ContinueStatement') {
    return new Set(node.label ? [node.label] : [])
  }
  return new Set()
}

/** Identifiers read as variables, with the line each is first read on. */
const referencedNames = (root: AnyNode): Map<string, number | undefined> => {
  const found = new Map<string, number | undefined>()
  const visit = (node: AnyNode): void => {
    if (node.type === 'Identifier') {
      if (!found.has(node.name)) found.set(node.name, node.loc?.start.line)
      return
    }
    if (node.type === 'MetaProperty') return
    // `typeof process` is how code checks for a global before using it.
    if (node.type === 'UnaryExpression' && node.operator === 'typeof') return
    const names = nameChildren(node)
    for (const child of children(node)) if (!names.has(child)) visit(child)
  }
  visit(root)
  return found
}

const parseSource = (source: string, format: 'body' | 'module'): AnyNode | undefined => {
  // Module sources may be TypeScript; strip types but keep imports as written.
  const code = format === 'module' ? moduleSourceAsJavaScript(source) : source
  if (code === undefined) return undefined
  try {
    return parse(code, {
      ecmaVersion: 'latest',
      sourceType: format === 'module' ? 'module' : 'script',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      locations: true,
    })
  } catch {
    // The runner reports syntax errors with the offending line; this check only looks at code that parses.
    return undefined
  }
}

/**
 * Checks a dynamic Host half before it runs. `import()` and an undeclared `require()` cannot work in the sandbox and
 * are refused with what to use instead; globals the sandbox lacks only produce notes, since the agent may guard them.
 * Body sources report line numbers; module sources are checked after type stripping and report none.
 */
export const checkDynamicHostSource = (source: string, format: 'body' | 'module' = 'body'): DynamicSourceFindings => {
  const root = parseSource(source, format)
  if (root === undefined) return { notes: [] }
  const declared = declaredNames(root)
  const where = (line: number | undefined) => (format === 'body' && line !== undefined ? `（第 ${line} 行）` : '')
  const refusals: string[] = []
  const visit = (node: AnyNode): void => {
    if (node.type === 'ImportExpression') {
      refusals.push(`import()${where(node.loc?.start.line)}`)
    } else if (
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'require' &&
      !declared.has('require')
    ) {
      refusals.push(`require()${where(node.loc?.start.line)}`)
    }
    for (const child of children(node)) visit(child)
  }
  visit(root)
  if (refusals.length > 0) {
    throw new Error(`动态扩展不能加载模块，Host 源码用了 ${refusals.join('、')}。${REPLACEMENTS}`)
  }
  const referenced = referencedNames(root)
  const notes = Object.entries(MISSING_GLOBALS).flatMap(([name, instead]) =>
    !referenced.has(name) || declared.has(name)
      ? []
      : [`Host 源码用了 ${name}${where(referenced.get(name))}，试运行环境里没有它：${instead}。`],
  )
  return { notes }
}
