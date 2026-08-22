import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const productRoot = 'apps/web/src'
const contributionCopyRoots = ['packages/adapter-web/src', 'packages/adapter-qq-openclaw/src']
const visibleSourceRoots = [productRoot, ...contributionCopyRoots]
const copyGuide = 'docs/01-术语与文案规范.md §4.1「界面文案只说明对象、范围和结果」'
const terminologyGuide = 'docs/01-术语与文案规范.md §3–4'
const exceptionConfigPath = 'scripts/baselines/user-visible-copy-exceptions.json'
const visibleAttributeNames = new Set([
  'alt',
  'aria-description',
  'aria-label',
  'confirmLabel',
  'description',
  'eyebrow',
  'hint',
  'label',
  'placeholder',
  'title',
])
const displayPropertyNames = new Set(['displayName', 'label', 'title', 'description', 'hint', 'placeholder'])
/** @type {ReadonlyArray<readonly [string, RegExp]>} */
const forbiddenTerms = [
  ['Agent', /\bAgent\b/iu],
  ['Revision', /\bRevision\b/iu],
  ['Activation', /\bActivation\b/iu],
  ['Admission', /\bAdmission\b/iu],
  ['PhysicalDelivery', /\bPhysicalDelivery\b/iu],
  ['Extension Draft', /\bExtension\s+Draft\b/iu],
  ['Client UI', /\bClient\s+UI\b/iu],
  ['Slot', /\bSlot\b/iu],
  ['Connection', /\bConnection\b/iu],
  ['Adapter', /\bAdapter\b/iu],
  ['Gateway', /\bGateway\b/iu],
  ['Session', /\bSession\b/iu],
  ['QQ', /QQ/u],
]
/** @type {ReadonlyArray<readonly [string, RegExp]>} */
const forbiddenCopyPatterns = [
  [
    'navigation-self-explanation',
    /(?:不(?:需要|必|用)(?:再)?(?:逐个|逐一)?(?:进入|前往|跳转|打开|切换到|离开|返回)|无需(?:再)?(?:逐个|逐一)?(?:进入|前往|跳转|打开|切换到|离开|返回)|(?:可|可以|能够|直接)(?:在|从)(?:本页|当前页|这个页面|该页面|这里|此处|当前区域)|(?:完成|保存|提交)后(?:仍|继续)?(?:留在|停留在|返回|回到)(?:本页|当前页|这个页面|该页面|这里|此处|当前区域|[^，。！？]{1,12}页)|(?:逐个|逐一)(?:进入|前往|打开|点击|切换))/u,
  ],
  ['speculative-negation', /(?:不会|无需|无须|不需要|不必|不用|不删除)/u],
  ['vague-sequence', /(?:之后|以后)/u],
  ['vague-continuity', /(?:保持|继续|仍然?|始终)/u],
  ['conditional-can', /才(?:能|会)/u],
  ['ambiguous-reopen', /重开/u],
  ['casual-navigation', /(?:^|[。！？；])到[「『“][^」』”]+[」』”]/u],
  ['em-dash', /—+/u],
]
const copyFindingMessages = new Map([
  ['navigation-self-explanation', '使用界面导航自我解说'],
  ['speculative-negation', '使用臆测式否定'],
  ['vague-sequence', '使用没有明确事件锚点的时序词'],
  ['vague-continuity', '使用多余或缺少对比对象的状态延续词'],
  ['conditional-can', '使用含糊的“才”式前置条件'],
  ['ambiguous-reopen', '使用含义不明确的“重开”'],
  ['casual-navigation', '使用口语化页面导航'],
  ['em-dash', '使用破折号或破折号占位'],
])
const technicalIdName = /(?:^id$|Id$|ID$|Key$|Ns$)/u

const normalizeVisibleText = (text) => text.replace(/\s+/gu, ' ').trim()

async function filesUnder(relativeDirectory, extensions = ['.tsx']) {
  const entries = await readdir(path.join(root, relativeDirectory), { withFileTypes: true })
  const output = []
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name)
    if (entry.isDirectory()) output.push(...(await filesUnder(relativePath, extensions)))
    else if (
      extensions.some((extension) => entry.name.endsWith(extension)) &&
      !relativePath.startsWith(`${productRoot}/ui-kit/`)
    )
      output.push(relativePath)
  }
  return output
}

const propertyName = (name) => {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text
  return undefined
}

const expressionName = (expression) => {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
    return ts.isStringLiteralLike(expression.argumentExpression) ? expression.argumentExpression.text : undefined
  }
  return undefined
}

function inspectSource(relativePath, source, { includeTerms = true } = {}) {
  const file = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const findings = []
  const displayedCollections = new Set()
  const displayedVariables = new Set()

  const addTextFinding = (node, text, context) => {
    const normalizedText = normalizeVisibleText(text)
    if (includeTerms) {
      for (const [term, pattern] of forbiddenTerms) {
        pattern.lastIndex = 0
        if (!pattern.test(normalizedText)) continue
        const position = file.getLineAndCharacterOfPosition(node.getStart(file))
        findings.push({
          file: relativePath,
          line: position.line + 1,
          rule: `term:${term}`,
          text: normalizedText,
          message: `用户可见${context}包含内部术语“${term}”。`,
        })
      }
    }
    for (const [name, pattern] of forbiddenCopyPatterns) {
      pattern.lastIndex = 0
      if (!pattern.test(normalizedText)) continue
      const position = file.getLineAndCharacterOfPosition(node.getStart(file))
      findings.push({
        file: relativePath,
        line: position.line + 1,
        rule: `copy:${name}`,
        text: normalizedText,
        message: `用户可见${context}${copyFindingMessages.get(name) ?? '使用受限文案模式'}“${normalizedText}”。`,
      })
      break
    }
  }

  const inspectTextExpression = (node, context) => {
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      addTextFinding(node, node.text, context)
      return
    }
    if (ts.isTemplateExpression(node)) {
      addTextFinding(node.head, node.head.text, context)
      for (const span of node.templateSpans) {
        inspectTextExpression(span.expression, context)
        addTextFinding(span.literal, span.literal.text, context)
      }
      return
    }
    if (ts.isConditionalExpression(node)) {
      inspectTextExpression(node.whenTrue, context)
      inspectTextExpression(node.whenFalse, context)
      return
    }
    if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)
    ) {
      let fallbackName = expressionName(node.right)
      const findTechnicalId = (candidate) => {
        if (fallbackName && technicalIdName.test(fallbackName)) return
        const candidateName = expressionName(candidate)
        if (candidateName && technicalIdName.test(candidateName)) {
          fallbackName = candidateName
          return
        }
        ts.forEachChild(candidate, findTechnicalId)
      }
      findTechnicalId(node.right)
      if (fallbackName && technicalIdName.test(fallbackName)) {
        const position = file.getLineAndCharacterOfPosition(node.getStart(file))
        findings.push({
          file: relativePath,
          line: position.line + 1,
          rule: 'technical-id-fallback',
          text: fallbackName,
          message: `用户可见表达式使用技术标识“${fallbackName}”作为名称回退。`,
        })
      }
      inspectTextExpression(node.left, context)
      inspectTextExpression(node.right, context)
      return
    }
    if (ts.isParenthesizedExpression(node)) inspectTextExpression(node.expression, context)
  }

  const collectDisplayedReferences = (node) => {
    if (ts.isJsxExpression(node) && node.expression) {
      if (ts.isIdentifier(node.expression) && !ts.isJsxAttribute(node.parent)) {
        displayedVariables.add(node.expression.text)
      }
      const scanExpression = (expression) => {
        if (
          ts.isCallExpression(expression) &&
          ts.isPropertyAccessExpression(expression.expression) &&
          expression.expression.name.text === 'map' &&
          ts.isIdentifier(expression.expression.expression)
        ) {
          displayedCollections.add(expression.expression.expression.text)
        }
        ts.forEachChild(expression, scanExpression)
      }
      scanExpression(node.expression)
    }
    if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) &&
      visibleAttributeNames.has(node.name.text) &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression &&
      ts.isIdentifier(node.initializer.expression)
    ) {
      displayedVariables.add(node.initializer.expression.text)
    }
    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name)
      if (name && displayPropertyNames.has(name) && ts.isIdentifier(node.initializer)) {
        displayedVariables.add(node.initializer.text)
      }
    }
    ts.forEachChild(node, collectDisplayedReferences)
  }
  collectDisplayedReferences(file)

  const visit = (node) => {
    if (ts.isJsxText(node) && node.text.trim()) addTextFinding(node, node.text, ' JSX 文本')

    if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) &&
      visibleAttributeNames.has(node.name.text) &&
      node.initializer
    ) {
      if (ts.isStringLiteral(node.initializer))
        addTextFinding(node.initializer, node.initializer.text, `属性 ${node.name.text}`)
      else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        inspectTextExpression(node.initializer.expression, `属性 ${node.name.text}`)
      }
    }

    if (ts.isJsxExpression(node) && node.expression) inspectTextExpression(node.expression, ' JSX 表达式')

    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name)
      if (name && displayPropertyNames.has(name)) inspectTextExpression(node.initializer, `展示映射 ${name}`)
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      displayedCollections.has(node.name.text) &&
      node.initializer
    ) {
      const collectionName = node.name.text
      const inspectCollection = (child) => {
        if (ts.isStringLiteralLike(child) || ts.isNoSubstitutionTemplateLiteral(child)) {
          addTextFinding(child, child.text, `展示集合 ${collectionName}`)
          return
        }
        if (!ts.isFunctionLike(child)) ts.forEachChild(child, inspectCollection)
      }
      inspectCollection(node.initializer)
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      displayedVariables.has(node.name.text) &&
      node.initializer
    ) {
      inspectTextExpression(node.initializer, `展示变量 ${node.name.text}`)
    }

    ts.forEachChild(node, visit)
  }
  visit(file)

  return findings.filter(
    (finding, index) =>
      findings.findIndex(
        (candidate) =>
          candidate.file === finding.file && candidate.line === finding.line && candidate.rule === finding.rule,
      ) === index,
  )
}

const knownRules = new Set([
  ...forbiddenTerms.map(([term]) => `term:${term}`),
  ...forbiddenCopyPatterns.map(([name]) => `copy:${name}`),
  'technical-id-fallback',
])

const exceptionKey = ({ file, rule, text }) => `${file}\0${rule}\0${text}`

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

function parseExceptionConfig(value) {
  if (!isRecord(value) || typeof value.description !== 'string' || !Array.isArray(value.exceptions)) {
    throw new Error(`${exceptionConfigPath} 必须包含 description 和 exceptions 数组。`)
  }
  const exceptions = value.exceptions.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`${exceptionConfigPath} exceptions[${index}] 必须是对象。`)
    const { file, rule, text, reason } = entry
    if (
      typeof file !== 'string' ||
      !visibleSourceRoots.some((sourceRoot) => file.startsWith(`${sourceRoot}/`)) ||
      !/\.tsx?$/u.test(file)
    ) {
      throw new Error(
        `${exceptionConfigPath} exceptions[${index}].file 必须指向用户可见文案检查范围内的 TS 或 TSX 文件。`,
      )
    }
    if (typeof rule !== 'string' || !knownRules.has(rule)) {
      throw new Error(`${exceptionConfigPath} exceptions[${index}].rule 不是当前检查器支持的规则。`)
    }
    if (typeof text !== 'string' || !normalizeVisibleText(text)) {
      throw new Error(`${exceptionConfigPath} exceptions[${index}].text 必须是完整的用户可见文案。`)
    }
    if (typeof reason !== 'string' || reason.trim().length < 8) {
      throw new Error(`${exceptionConfigPath} exceptions[${index}].reason 必须说明至少 8 个字符的保留理由。`)
    }
    return { file, rule, text: normalizeVisibleText(text), reason: reason.trim() }
  })
  const keys = exceptions.map(exceptionKey)
  if (new Set(keys).size !== keys.length) throw new Error(`${exceptionConfigPath} 包含重复例外。`)
  return exceptions
}

function applyExceptions(findings, exceptions) {
  const used = new Set()
  const remaining = findings.filter((finding) => {
    const key = exceptionKey(finding)
    const matched = exceptions.some((exception) => exceptionKey(exception) === key)
    if (matched) used.add(key)
    return !matched
  })
  return {
    findings: remaining,
    staleExceptions: exceptions.filter((exception) => !used.has(exceptionKey(exception))),
  }
}

const guidanceForRule = (rule) => (rule.startsWith('copy:') ? copyGuide : terminologyGuide)

const formatFindings = (findings) =>
  [
    '发现用户可见术语或文案问题：',
    ...findings.flatMap((finding) => [
      `${finding.file}:${finding.line} [${finding.rule}] ${finding.message}`,
      `  文案：“${finding.text}”`,
      `  修正：请阅读 ${guidanceForRule(finding.rule)}。`,
    ]),
    `如该文案在此处确有必要，请在 ${exceptionConfigPath} 添加精确的 file、rule、text 和 reason；不要在源码中添加忽略注释。`,
  ].join('\n')

const formatStaleExceptions = (exceptions) =>
  [
    `发现 ${exceptionConfigPath} 中未命中的陈旧例外：`,
    ...exceptions.map((exception) => `${exception.file} [${exception.rule}] “${exception.text}” — ${exception.reason}`),
    '请删除失效例外，或把它更新为当前仍需保留的精确文案。',
  ].join('\n')

function runSelfTest({ log = true } = {}) {
  const fixture = `
// Agent and Session are valid in developer comments.
interface AgentSession { id: string }
const events = [['Gateway resume', 'ok']]
const mapping = { label: 'Client UI' }
const dialogDescription = '保存后不必离开当前页面。'
export function Fixture({ model }) {
  return <section className="Agent"><h2>Extension Draft</h2>
    <p>通过 QQ 发言</p>
    <Field hint="new Revision" />
    <span>{model.name ?? model.id}</span>
    <p>不需要逐个进入扩展详情。</p>
    <Field description="可在本页管理。" />
    <Field description={dialogDescription} />
    <p>完成后仍留在连接页。</p>
    <p>内置频道不需要配置账号凭据。</p>
    <p>保存后不会自动启用。</p>
    <p>保存之后启用。</p>
    <p>配置保持可用。</p>
    <p>创建后才能启用。</p>
    <p>压缩并重开。</p>
    <p>接入平台。到「连接」添加账号。</p>
    <p>暂无数据——稍后再试。</p>
    <p>不删除外部频道。</p>
    {events.map(([title]) => <div>{title}</div>)}
  </section>
}`
  const findings = inspectSource('fixtures/terminology.tsx', fixture)
  assert.deepEqual(
    findings.map(({ line, rule }) => [line, rule]),
    [
      [4, 'term:Gateway'],
      [5, 'term:Client UI'],
      [6, 'copy:navigation-self-explanation'],
      [8, 'term:Extension Draft'],
      [9, 'term:QQ'],
      [10, 'term:Revision'],
      [11, 'technical-id-fallback'],
      [12, 'copy:navigation-self-explanation'],
      [13, 'copy:navigation-self-explanation'],
      [15, 'copy:navigation-self-explanation'],
      [16, 'copy:speculative-negation'],
      [17, 'copy:speculative-negation'],
      [18, 'copy:vague-sequence'],
      [19, 'copy:vague-continuity'],
      [20, 'copy:conditional-can'],
      [21, 'copy:ambiguous-reopen'],
      [22, 'copy:casual-navigation'],
      [23, 'copy:em-dash'],
      [24, 'copy:speculative-negation'],
    ],
  )
  assert.equal(
    findings.some(({ message }) => message.includes('className')),
    false,
  )
  assert.deepEqual(
    inspectSource(
      `${contributionCopyRoots[0]}/fixture.ts`,
      `export const adapter = { displayName: 'QQ 官方机器人', description: '保存之后启用。' }`,
      { includeTerms: false },
    ).map(({ rule }) => rule),
    ['copy:vague-sequence'],
    'Adapter 元数据必须检查文案模式，但平台展示名不应触发产品壳术语规则。',
  )
  const configured = parseExceptionConfig({
    description: 'fixture',
    exceptions: [
      {
        file: 'fixtures/terminology.tsx'.replace('fixtures', productRoot),
        rule: 'copy:speculative-negation',
        text: '保存后不会自动启用。',
        reason: '验证精确文案例外会被消费。',
      },
    ],
  })
  const exceptionFixture = inspectSource(
    `${productRoot}/terminology.tsx`,
    'export function Fixture() { return <p>保存后不会自动启用。</p> }',
  )
  const applied = applyExceptions(exceptionFixture, configured)
  assert.equal(applied.findings.length, 0)
  assert.equal(applied.staleExceptions.length, 0)
  assert.equal(applyExceptions([], configured).staleExceptions.length, 1, '没有命中的例外必须被识别为陈旧配置。')
  assert.throws(
    () =>
      parseExceptionConfig({
        description: 'fixture',
        exceptions: [
          {
            file: `${productRoot}/fixture.tsx`,
            rule: 'copy:navigation-self-explanation',
            text: '可在本页管理。',
            reason: '太短',
          },
        ],
      }),
    /至少 8 个字符/u,
  )
  const copyOutput = formatFindings(
    findings.filter(({ rule }) => rule === 'copy:navigation-self-explanation').slice(0, 1),
  )
  assert.match(copyOutput, /docs\/01-术语与文案规范\.md §4\.1/u)
  assert.match(copyOutput, /scripts\/baselines\/user-visible-copy-exceptions\.json/u)
  assert.match(copyOutput, /保存后不必离开当前页面/u)
  assert.match(formatStaleExceptions(configured), /未命中的陈旧例外/u)
  if (log) {
    console.log(
      'Terminology self-test passed (visible copy, copy anti-patterns, exact exceptions and stale exceptions are covered).',
    )
  }
}

if (process.argv.includes('--self-test')) {
  runSelfTest()
} else {
  runSelfTest({ log: false })
  const productSourceFiles = await filesUnder(productRoot)
  const contributionSourceFiles = (
    await Promise.all(contributionCopyRoots.map((sourceRoot) => filesUnder(sourceRoot, ['.ts', '.tsx'])))
  ).flat()
  const sourceFiles = [...productSourceFiles, ...contributionSourceFiles].sort()
  const findings = []
  for (const relativePath of sourceFiles) {
    const source = await readFile(path.join(root, relativePath), 'utf8')
    findings.push(...inspectSource(relativePath, source, { includeTerms: relativePath.startsWith(`${productRoot}/`) }))
  }
  let exceptions
  try {
    exceptions = parseExceptionConfig(JSON.parse(await readFile(path.join(root, exceptionConfigPath), 'utf8')))
  } catch (error) {
    console.error(`用户可见文案例外配置无效：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
  const checked = applyExceptions(findings, exceptions)
  if (checked.findings.length > 0) {
    console.error(formatFindings(checked.findings))
    process.exitCode = 1
  }
  if (checked.staleExceptions.length > 0) {
    console.error(formatStaleExceptions(checked.staleExceptions))
    process.exitCode = 1
  }
  if (checked.findings.length === 0 && checked.staleExceptions.length === 0) {
    console.log(`User-facing terminology check passed (${sourceFiles.length} UI and contribution source files).`)
  }
}
