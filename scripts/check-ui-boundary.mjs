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
    if (
      !isUiKit &&
      (moduleSpecifier === 'motion' || moduleSpecifier === 'framer-motion' || moduleSpecifier?.startsWith('motion/'))
    ) {
      addFinding(node, 'motion-import', `业务代码不得直接导入 ${moduleSpecifier}；请由 ui-kit 封装。`)
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
import { motion } from 'motion/react'
export function Fixture() {
  return <><button /><select /><input type="submit" hidden /></>
}`
  const uiKit = `import * as Dialog from '@radix-ui/react-dialog'; import { motion } from 'motion/react'; export const Control = () => <button />`
  const findings = inspectSource('apps/web/src/fixture.tsx', business)
  assert.deepEqual(
    findings.map(({ line, rule }) => [line, rule]),
    [
      [2, 'radix-import'],
      [3, 'motion-import'],
      [5, 'native-control:button'],
      [5, 'native-control:select'],
    ],
  )
  assert.deepEqual(inspectSource('apps/web/src/ui-kit/fixture.tsx', uiKit), [])
  console.log('UI boundary self-test passed (Radix/Motion/native controls rejected; ui-kit and hidden submit allowed).')
}

/**
 * Extension UI V6 (Decision 2026-10-04 §5) replaced page-position Slots with semantic anchors. Their names must not
 * return in product code or tests; archived docs keep them as history.
 */
const RETIRED_SLOT_NAMES =
  /\b(?:agent\.workbench\.sections|extension\.details\.panels|connection\.adapter\.(?:setup|status|test))\b/u
const retiredSlotRoots = [
  'apps/web/src',
  'apps/web/tests',
  'apps/web/browser-tests',
  'apps/server/src',
  'apps/server/tests',
]

const retiredSlotFindings = async () => {
  const findings = []
  for (const directory of retiredSlotRoots) {
    for (const relativePath of await filesUnder(directory)) {
      const lines = (await readFile(path.join(root, relativePath), 'utf8')).split('\n')
      lines.forEach((line, index) => {
        if (RETIRED_SLOT_NAMES.test(line)) findings.push(`${relativePath}:${index + 1} 使用了已退役的 V5 Slot 名`)
      })
    }
  }
  return findings
}

/**
 * Decision 2026-10-06 §6.1: every space entry renders one of the three page layouts, so width, scrolling and the
 * list/detail split behave the same everywhere.
 */
const SPACE_LAYOUT = /<(?:ReaderPage|WorkbenchPage|BoardPage)\b/u
const spaceLayoutFindings = async () => {
  const spaces = (await filesUnder(`${webSourceRoot}/app`)).filter((file) => /\/[a-z-]+-space\.tsx$/u.test(file))
  const findings = []
  for (const relativePath of spaces) {
    if (!SPACE_LAYOUT.test(await readFile(path.join(root, relativePath), 'utf8')))
      findings.push(`${relativePath} 没有使用 ReaderPage、WorkbenchPage 或 BoardPage`)
  }
  return { spaces: spaces.length, findings }
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
  const layouts = await spaceLayoutFindings()
  if (layouts.spaces === 0 || layouts.findings.length > 0) {
    console.error(['空间入口必须使用三种页面版式之一：', ...layouts.findings].join('\n'))
    process.exitCode = 1
  }
  const retired = await retiredSlotFindings()
  if (retired.length > 0) {
    console.error(['发现已退役的扩展 Slot：', ...retired].join('\n'))
    process.exitCode = 1
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
