import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const productRoot = 'apps/web/src'
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
]
const technicalIdName = /(?:^id$|Id$|ID$|Key$|Ns$)/u

async function filesUnder(relativeDirectory) {
  const entries = await readdir(path.join(root, relativeDirectory), { withFileTypes: true })
  const output = []
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name)
    if (entry.isDirectory()) output.push(...(await filesUnder(relativePath)))
    else if (entry.name.endsWith('.tsx') && !relativePath.startsWith(`${productRoot}/ui-kit/`))
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

function inspectSource(relativePath, source) {
  const file = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const findings = []
  const displayedCollections = new Set()

  const addTextFinding = (node, text, context) => {
    for (const [term, pattern] of forbiddenTerms) {
      pattern.lastIndex = 0
      if (!pattern.test(text)) continue
      const position = file.getLineAndCharacterOfPosition(node.getStart(file))
      findings.push({
        file: relativePath,
        line: position.line + 1,
        rule: `term:${term}`,
        message: `用户可见${context}包含内部术语“${term}”。`,
      })
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
          message: `用户可见表达式使用技术标识“${fallbackName}”作为名称回退。`,
        })
      }
      inspectTextExpression(node.left, context)
      inspectTextExpression(node.right, context)
      return
    }
    if (ts.isParenthesizedExpression(node)) inspectTextExpression(node.expression, context)
  }

  const collectDisplayedCollections = (node) => {
    if (ts.isJsxExpression(node) && node.expression) {
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
    ts.forEachChild(node, collectDisplayedCollections)
  }
  collectDisplayedCollections(file)

  const visit = (node) => {
    if (ts.isJsxText(node) && node.text.trim()) addTextFinding(node, node.text, ' JSX 文本')

    if (ts.isJsxAttribute(node) && visibleAttributeNames.has(node.name.text) && node.initializer) {
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
      const inspectCollection = (child) => {
        if (ts.isStringLiteralLike(child) || ts.isNoSubstitutionTemplateLiteral(child)) {
          addTextFinding(child, child.text, `展示集合 ${node.name.text}`)
          return
        }
        if (!ts.isFunctionLike(child)) ts.forEachChild(child, inspectCollection)
      }
      inspectCollection(node.initializer)
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

function runSelfTest() {
  const fixture = `
// Agent and Session are valid in developer comments.
interface AgentSession { id: string }
const events = [['Gateway resume', 'ok']]
const mapping = { label: 'Client UI' }
export function Fixture({ model }) {
  return <section className="Agent"><h2>Extension Draft</h2>
    <Field hint="new Revision" />
    <span>{model.name ?? model.id}</span>
    {events.map(([title]) => <div>{title}</div>)}
  </section>
}`
  const findings = inspectSource('fixtures/terminology.tsx', fixture)
  assert.deepEqual(
    findings.map(({ line, rule }) => [line, rule]),
    [
      [4, 'term:Gateway'],
      [5, 'term:Client UI'],
      [7, 'term:Extension Draft'],
      [8, 'term:Revision'],
      [9, 'technical-id-fallback'],
    ],
  )
  assert.equal(
    findings.some(({ message }) => message.includes('className')),
    false,
  )
  console.log(
    'Terminology self-test passed (visible copy, display mappings and technical ID fallbacks have exact lines).',
  )
}

if (process.argv.includes('--self-test')) {
  runSelfTest()
} else {
  const sourceFiles = (await filesUnder(productRoot)).sort()
  const findings = []
  for (const relativePath of sourceFiles) {
    const source = await readFile(path.join(root, relativePath), 'utf8')
    findings.push(...inspectSource(relativePath, source))
  }
  if (findings.length > 0) {
    console.error(
      [
        '发现用户可见内部术语：',
        ...findings.map((finding) => `${finding.file}:${finding.line} [${finding.rule}] ${finding.message}`),
      ].join('\n'),
    )
    process.exitCode = 1
  } else {
    console.log(`User-facing terminology check passed (${sourceFiles.length} product TSX files).`)
  }
}
