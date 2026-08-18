import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const webSourceRoot = 'apps/web/src'
const uiKitRoot = `${webSourceRoot}/ui-kit/`
const nativeControlTags = new Set(['button', 'select', 'input', 'textarea'])

async function filesUnder(relativeDirectory) {
  const entries = await readdir(path.join(root, relativeDirectory), { withFileTypes: true })
  const output = []
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name)
    if (entry.isDirectory()) output.push(...(await filesUnder(relativePath)))
    else if (/\.[cm]?[jt]sx?$/u.test(entry.name)) output.push(relativePath)
  }
  return output
}

const attribute = (attributes, name) =>
  attributes.properties.find(
    (property) => ts.isJsxAttribute(property) && ts.isIdentifier(property.name) && property.name.text === name,
  )

const staticBooleanAttribute = (attributes, name) => {
  const candidate = attribute(attributes, name)
  if (!candidate) return false
  if (!candidate.initializer) return true
  return (
    ts.isJsxExpression(candidate.initializer) && candidate.initializer.expression?.kind === ts.SyntaxKind.TrueKeyword
  )
}

const staticStringAttribute = (attributes, name) => {
  const candidate = attribute(attributes, name)
  if (!candidate?.initializer) return undefined
  if (ts.isStringLiteral(candidate.initializer)) return candidate.initializer.text
  if (ts.isJsxExpression(candidate.initializer) && ts.isStringLiteralLike(candidate.initializer.expression)) {
    return candidate.initializer.expression.text
  }
  return undefined
}

const hiddenSubmit = (tagName, attributes) =>
  (tagName === 'button' || tagName === 'input') &&
  staticStringAttribute(attributes, 'type') === 'submit' &&
  staticBooleanAttribute(attributes, 'hidden')

function inspectSource(relativePath, source) {
  const scriptKind = relativePath.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const file = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, scriptKind)
  const isUiKit = relativePath.startsWith(uiKitRoot)
  const findings = []
  const addFinding = (node, rule, message) => {
    const position = file.getLineAndCharacterOfPosition(node.getStart(file))
    findings.push({ file: relativePath, line: position.line + 1, rule, message })
  }

  const visit = (node) => {
    const moduleSpecifier =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : undefined
    if (!isUiKit && moduleSpecifier?.startsWith('@radix-ui/')) {
      addFinding(node, 'radix-import', `业务代码不得直接导入 ${moduleSpecifier}；请由 ui-kit 封装。`)
    }
    if (!isUiKit && (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))) {
      const tagName = node.tagName.getText(file)
      if (nativeControlTags.has(tagName) && !hiddenSubmit(tagName, node.attributes)) {
        addFinding(node, `native-control:${tagName}`, `业务代码不得直接使用原生 <${tagName}>；请使用 ui-kit。`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return findings
}

function runSelfTest() {
  const business = `
import * as Dialog from '@radix-ui/react-dialog'
export function Fixture() {
  return <><button /><select /><input type="submit" hidden /></>
}`
  const uiKit = `import * as Dialog from '@radix-ui/react-dialog'; export const Control = () => <button />`
  const findings = inspectSource('apps/web/src/fixture.tsx', business)
  assert.deepEqual(
    findings.map(({ line, rule }) => [line, rule]),
    [
      [2, 'radix-import'],
      [4, 'native-control:button'],
      [4, 'native-control:select'],
    ],
  )
  assert.deepEqual(inspectSource('apps/web/src/ui-kit/fixture.tsx', uiKit), [])
  console.log('UI boundary self-test passed (Radix/native controls rejected; ui-kit and hidden submit allowed).')
}

if (process.argv.includes('--self-test')) {
  runSelfTest()
} else {
  const sourceFiles = (await filesUnder(webSourceRoot)).sort()
  const findings = []
  for (const relativePath of sourceFiles) {
    const source = await readFile(path.join(root, relativePath), 'utf8')
    findings.push(...inspectSource(relativePath, source))
  }
  if (findings.length > 0) {
    console.error(
      [
        '发现 ui-kit 边界违规：',
        ...findings.map((finding) => `${finding.file}:${finding.line} [${finding.rule}] ${finding.message}`),
      ].join('\n'),
    )
    process.exitCode = 1
  } else {
    console.log(`UI boundary check passed (${sourceFiles.length} web source files).`)
  }
}
