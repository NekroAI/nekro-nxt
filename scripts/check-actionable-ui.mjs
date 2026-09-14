import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'

async function filesUnder(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await filesUnder(file)))
    else if (entry.name.endsWith('.tsx')) files.push(file)
  }
  return files
}

// An explicit empty inline handler is useful review evidence, never proof that
// a rendered control has no effect (forms, links and event bubbling also act).
let suggestions = 0
for (const file of await filesUnder('apps/web/src')) {
  const source = ts.createSourceFile(
    file,
    await readFile(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const visit = (node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      !node.attributes.properties.some(ts.isJsxSpreadAttribute)
    ) {
      for (const attribute of node.attributes.properties) {
        if (
          !ts.isJsxAttribute(attribute) ||
          attribute.name.getText(source) !== 'onClick' ||
          !attribute.initializer ||
          !ts.isJsxExpression(attribute.initializer)
        )
          continue
        const handler = attribute.initializer.expression
        if (!handler || !ts.isArrowFunction(handler) || !ts.isBlock(handler.body) || handler.body.statements.length)
          continue
        suggestions += 1
        console.warn(
          `${file}:${source.getLineAndCharacterOfPosition(attribute.getStart(source)).line + 1} 显式空 onClick：请在交互测试中确认实际结果。`,
        )
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}
console.log(`UI action review: ${suggestions} suggestions; interaction tests own acceptance.`)
