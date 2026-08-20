import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const productRoot = 'apps/web/src'
const actionableTags = new Set(['Button', 'IconButton', 'button'])
const semanticTriggerTags = new Set(['DropdownMenu.Trigger'])

const attribute = (attributes, name) =>
  attributes.properties.find(
    (property) => ts.isJsxAttribute(property) && ts.isIdentifier(property.name) && property.name.text === name,
  )

const expressionAttribute = (attributes, name) => {
  const candidate = attribute(attributes, name)
  return candidate?.initializer && ts.isJsxExpression(candidate.initializer)
    ? candidate.initializer.expression
    : undefined
}

const literalAttribute = (attributes, name, value) => {
  const candidate = attribute(attributes, name)
  if (!candidate?.initializer) return false
  if (ts.isStringLiteral(candidate.initializer)) return candidate.initializer.text === value
  const expression = ts.isJsxExpression(candidate.initializer) ? candidate.initializer.expression : undefined
  return expression !== undefined && ts.isStringLiteralLike(expression) && expression.text === value
}

const permanentlyDisabled = (attributes) => {
  const candidate = attribute(attributes, 'disabled')
  if (!candidate) return false
  if (!candidate.initializer) return true
  return expressionAttribute(attributes, 'disabled')?.kind === ts.SyntaxKind.TrueKeyword
}

const meaningfulHandler = (attributes, name) => {
  const handler = expressionAttribute(attributes, name)
  if (!handler || handler.kind === ts.SyntaxKind.NullKeyword || handler.kind === ts.SyntaxKind.FalseKeyword)
    return false
  if (ts.isIdentifier(handler) && handler.text === 'undefined') return false
  if (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) {
    if (ts.isBlock(handler.body)) return handler.body.statements.length > 0
    if (handler.body.kind === ts.SyntaxKind.NullKeyword || handler.body.kind === ts.SyntaxKind.FalseKeyword)
      return false
    if (ts.isIdentifier(handler.body) && handler.body.text === 'undefined') return false
  }
  return true
}

const wrappedBySemanticTrigger = (node, file) => {
  const candidates = [node.parent, node.parent?.parent]
  return candidates.some(
    (candidate) =>
      ts.isJsxElement(candidate) && semanticTriggerTags.has(candidate.openingElement.tagName.getText(file)),
  )
}

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

function inspectSource(relativePath, source) {
  const file = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const failures = []
  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagName = node.tagName.getText(file)
      if (actionableTags.has(tagName)) {
        const hasHandler = ['onClick', 'onPointerDown', 'onKeyDown'].some((name) =>
          meaningfulHandler(node.attributes, name),
        )
        const submitsForm = literalAttribute(node.attributes, 'type', 'submit')
        if (
          !hasHandler &&
          !submitsForm &&
          !permanentlyDisabled(node.attributes) &&
          !wrappedBySemanticTrigger(node, file)
        ) {
          const position = file.getLineAndCharacterOfPosition(node.getStart(file))
          failures.push({
            file: relativePath,
            line: position.line + 1,
            message: `<${tagName}> 没有有效点击、指针、键盘、语义触发器、submit 或永久禁用；条件 disabled 不能替代操作。`,
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return failures
}

function runSelfTest() {
  const fixture = `
export function Fixture({ pending }) {
  return <>
    <Button onClick={() => doWork()} />
    <IconButton type="submit" />
    <button disabled />
    <Button disabled={pending} />
    <button onClick={() => {}} />
    <Button onClick={() => undefined} />
    <Button onKeyDown={() => doWork()} />
    <DropdownMenu.Trigger><IconButton /></DropdownMenu.Trigger>
  </>
}`
  const failures = inspectSource('fixtures/actionable.tsx', fixture)
  assert.deepEqual(
    failures.map(({ line }) => line),
    [7, 8, 9],
  )
  assert.match(failures[0].message, /条件 disabled/u)
  console.log('Actionable UI self-test passed (conditional disabled and empty handlers are rejected with exact lines).')
}

if (process.argv.includes('--self-test')) {
  runSelfTest()
} else {
  const sourceFiles = (await filesUnder(productRoot)).sort()
  const failures = []
  for (const relativePath of sourceFiles) {
    const source = await readFile(path.join(root, relativePath), 'utf8')
    failures.push(...inspectSource(relativePath, source))
  }

  if (failures.length > 0) {
    console.error(
      [
        '发现会呈现为空操作的产品按钮：',
        ...failures.map((failure) => `${failure.file}:${failure.line} ${failure.message}`),
      ].join('\n'),
    )
    process.exitCode = 1
  } else {
    console.log(`Actionable UI check passed (${sourceFiles.length} product TSX files).`)
  }
}
