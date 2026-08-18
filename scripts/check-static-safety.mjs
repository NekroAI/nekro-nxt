import { readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript'

import { compareCounts, countsFromFindings, readBaseline, writeBaseline } from './lib/quality-baseline.mjs'

const root = process.cwd()
const baselinePath = 'scripts/baselines/static-safety.json'
const sourceRoots = ['apps', 'packages']
const sourcePattern = /\.(?:cts|mts|ts|tsx)$/u
const sqlStart =
  /^\s*(?:SELECT\b[\s\S]*\bFROM\b|INSERT\s+INTO\b|UPDATE\s+[A-Za-z_][\w$]*\s+SET\b|DELETE\s+FROM\b|CREATE\s+(?:(?:UNIQUE|VIRTUAL)\s+)?(?:INDEX|TABLE|TRIGGER|VIEW)\b|ALTER\s+TABLE\b|DROP\s+(?:INDEX|TABLE|TRIGGER|VIEW)\b|PRAGMA\s+[A-Za-z_]|BEGIN(?:\s+(?:DEFERRED|EXCLUSIVE|IMMEDIATE|TRANSACTION))?\s*;?\s*$|COMMIT\s*;?\s*$|ROLLBACK\s*;?\s*$|WITH\b[\s\S]*\b(?:DELETE|INSERT|SELECT|UPDATE)\b)/iu
const exemptFiles = new Set(['packages/storage-sqlite/src/schema.ts'])

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

function isJsonParse(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'JSON' &&
    node.expression.name.text === 'parse'
  )
}

function isImmediatelyValidated(node) {
  let current = node
  while (
    current.parent &&
    (ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) ||
      ts.isParenthesizedExpression(current.parent))
  ) {
    current = current.parent
  }
  const parent = current.parent
  if (!parent || !ts.isCallExpression(parent) || !parent.arguments.includes(current)) return false
  const callee = parent.expression.getText()
  return /(?:^|\.)(?:decode|parse|safeParse|validate)[A-Za-z0-9_$]*$/u.test(callee)
}

function assertionTypeText(node, sourceFile) {
  return node.type.getText(sourceFile).replace(/\s+/gu, ' ').trim()
}

function scanFile(file, fixedExceptions) {
  const relative = path.relative(root, file).split(path.sep).join('/')
  if (exemptFiles.has(relative)) return []
  const content = ts.sys.readFile(file)
  if (content === undefined) throw new Error(`Cannot read ${relative}`)
  const kind = relative.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind)
  const findings = []

  function report(rule, node, message) {
    const text = normalizedText(node, sourceFile)
    const excepted = fixedExceptions.some(
      (entry) => entry.rule === rule && entry.file === relative && entry.text === text,
    )
    if (excepted) return
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
    if (ts.isCallExpression(node)) {
      const member = propertyName(node.expression)
      const firstValue = node.arguments[0] && stringValue(node.arguments[0])
      if ((member === 'prepare' || member === 'exec') && firstValue !== undefined && sqlStart.test(firstValue)) {
        report('forbidden-sql-api', node, `业务源码不得调用 .${member}() 执行 SQL`)
      }
      if (
        member === 'raw' &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(sourceFile) === 'sql'
      ) {
        report('forbidden-sql-api', node, '业务源码不得调用 sql.raw()')
      }
      if (isJsonParse(node) && !isImmediatelyValidated(node)) {
        report('unchecked-json-parse', node, 'JSON.parse() 结果必须立即经过运行时 schema/decoder 校验')
      }
    }

    if (
      (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) &&
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

const baseline = await readBaseline(root, baselinePath).catch((error) => {
  if (process.argv.includes('--write-baseline') && error?.code === 'ENOENT') {
    return { version: 1, counts: {}, fixedExceptions: [] }
  }
  throw error
})
const files = (await Promise.all(sourceRoots.map((directory) => sourceFiles(path.join(root, directory))))).flat()
const findings = files.flatMap((file) => scanFile(file, baseline.fixedExceptions ?? []))
const counts = countsFromFindings(findings)

if (process.argv.includes('--print-findings')) {
  console.log(JSON.stringify(findings, null, 2))
}

if (process.argv.includes('--write-baseline')) {
  await writeBaseline(root, baselinePath, {
    version: 1,
    description: '生产源码静态安全债务；按规则和文件计数只能下降。DSH 固定例外必须匹配完整表达式。',
    counts,
    fixedExceptions: baseline.fixedExceptions ?? [],
  })
  console.log(`Static safety baseline updated (${findings.length} findings).`)
  process.exit(0)
}

const regressions = compareCounts(counts, baseline.counts ?? {})
if (regressions.length > 0) {
  for (const regression of regressions) {
    console.error(
      `${regression.file}: ${regression.rule} 当前 ${regression.count}，基线 ${regression.allowed}；新增静态债务被拒绝`,
    )
    for (const finding of findings.filter((item) => item.rule === regression.rule && item.file === regression.file)) {
      console.error(`  ${finding.line}:${finding.column} ${finding.message}: ${finding.text}`)
    }
  }
  process.exitCode = 1
} else {
  console.log(`Static safety check passed (${findings.length} baseline findings, no increases).`)
}
