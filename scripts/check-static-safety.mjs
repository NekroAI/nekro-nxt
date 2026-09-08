import { readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript'

const root = process.cwd()
const sourceRoots = ['apps', 'packages']
const sourcePattern = /\.(?:cts|mts|ts|tsx)$/u
const sqlStart =
  /^\s*(?:SELECT\b[\s\S]*\bFROM\b|INSERT\s+INTO\b|UPDATE\s+[A-Za-z_][\w$]*\s+SET\b|DELETE\s+FROM\b|CREATE\s+(?:(?:UNIQUE|VIRTUAL)\s+)?(?:INDEX|TABLE|TRIGGER|VIEW)\b|ALTER\s+TABLE\b|DROP\s+(?:INDEX|TABLE|TRIGGER|VIEW)\b|PRAGMA\s+[A-Za-z_]|BEGIN(?:\s+(?:DEFERRED|EXCLUSIVE|IMMEDIATE|TRANSACTION))?\s*;?\s*$|COMMIT\s*;?\s*$|ROLLBACK\s*;?\s*$|WITH\b[\s\S]*\b(?:DELETE|INSERT|SELECT|UPDATE)\b)/iu
const exemptFiles = new Set([
  'packages/storage-sqlite/src/schema.ts',
  // Migration runner owns native SQL and the transaction commit boundary.
  'packages/storage-sqlite/src/database.ts',
  // This adapter owns the foreign DSH SQLite identity/backup protocol. It
  // deliberately cannot use the Core Drizzle schema because NekroNxt must not
  // import or model DSH's private tables.
  'packages/storage-sqlite/src/dsh-session-storage.ts',
])

async function sourceFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['dist', 'lib', 'node_modules', 'tests'].includes(entry.name)) continue
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await sourceFiles(target)))
    else if (sourcePattern.test(entry.name)) files.push(target)
  }
  return files
}

function normalizedText(node, sourceFile) {
  return node.getText(sourceFile).replace(/\s+/gu, ' ').trim()
}

function stringValue(node) {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) return node.head.text
  return undefined
}

function propertyName(expression) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
    return stringValue(expression.argumentExpression)
  }
  return undefined
}

function assertionTypeText(node, sourceFile) {
  return node.type.getText(sourceFile).replace(/\s+/gu, ' ').trim()
}

function scanFile(file) {
  const relative = path.relative(root, file).split(path.sep).join('/')
  if (exemptFiles.has(relative)) return []
  const content = ts.sys.readFile(file)
  if (content === undefined) throw new Error(`Cannot read ${relative}`)
  const kind = relative.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind)
  const findings = []
  const isMainApplication = relative.startsWith('apps/server/src/') || relative.startsWith('apps/web/src/')

  const isAdapterKeyExpression = (node) =>
    (ts.isIdentifier(node) && node.text === 'adapterKey') ||
    (ts.isPropertyAccessExpression(node) && node.name.text === 'adapterKey')

  function report(rule, node, message) {
    const text = normalizedText(node, sourceFile)
    const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    findings.push({
      rule,
      file: relative,
      line: location.line + 1,
      column: location.character + 1,
      message,
      text,
    })
  }

  function visit(node) {
    if (
      ts.isBinaryExpression(node) &&
      isMainApplication &&
      [
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ].includes(node.operatorToken.kind) &&
      ((isAdapterKeyExpression(node.left) && stringValue(node.right) !== undefined) ||
        (isAdapterKeyExpression(node.right) && stringValue(node.left) !== undefined))
    ) {
      report(
        'platform-key-branch',
        node,
        'Server 与通用 Web 页面必须通过 Adapter descriptor/Registry 能力分支，不能判断具体平台 key',
      )
    }
    if (
      isMainApplication &&
      (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      /(?:qq-group|qq-direct|\bQQ\b|OneBot|企业微信)/u.test(node.text)
    ) {
      report('platform-name-in-main-app', node, '主应用生产源码不得编码具体平台名称或旧频道类型。')
    }
    if (ts.isCallExpression(node)) {
      const member = propertyName(node.expression)
      const firstValue = node.arguments[0] && stringValue(node.arguments[0])
      if (
        !relative.startsWith('packages/storage-sqlite/src/') &&
        (member === 'prepare' || member === 'exec') &&
        firstValue !== undefined &&
        sqlStart.test(firstValue)
      ) {
        report('forbidden-sql-api', node, `业务源码不得调用 .${member}() 执行 SQL`)
      }
      if (
        member === 'raw' &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(sourceFile) === 'sql'
      ) {
        report('forbidden-sql-api', node, '业务源码不得调用 sql.raw()')
      }
    }

    if (
      (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) &&
      !relative.startsWith('packages/storage-sqlite/src/') &&
      sqlStart.test(stringValue(node) ?? '')
    ) {
      report('string-sql', node, '业务源码不得包含字符串 SQL')
    }

    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      if (assertionTypeText(node, sourceFile) === 'never') {
        report('as-never', node, '禁止使用 as never 绕过类型系统')
      }
      const inner = node.expression
      if (
        (ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner)) &&
        assertionTypeText(inner, sourceFile) === 'unknown'
      ) {
        report('double-unknown-assertion', node, '禁止使用 as unknown as 双重断言')
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return findings
}

const files = (await Promise.all(sourceRoots.map((directory) => sourceFiles(path.join(root, directory))))).flat()
const findings = files.flatMap((file) => scanFile(file))
if (process.argv.includes('--print-findings')) console.log(JSON.stringify(findings, null, 2))
for (const finding of findings) console.error(`${finding.file}:${finding.line} ${finding.rule}: ${finding.message}`)
if (findings.length) process.exitCode = 1
else console.log('Static safety check passed.')
