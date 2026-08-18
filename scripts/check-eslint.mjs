import path from 'node:path'
import process from 'node:process'
import { ESLint } from 'eslint'

import { countsFromFindings, readBaseline } from './lib/quality-baseline.mjs'

const root = process.cwd()
const interopAllowancePath = 'scripts/baselines/dsh-interop-assertions.json'
const assertionRules = new Set([
  '@typescript-eslint/no-unsafe-type-assertion',
  '@typescript-eslint/no-unnecessary-type-assertion',
])
const allowance = await readBaseline(root, interopAllowancePath)
const eslint = new ESLint({ cwd: root })
const results = await eslint.lintFiles(['.'])
const interopFindings = []
const errors = []

for (const result of results) {
  const file = path.relative(root, result.filePath).split(path.sep).join('/')
  for (const message of result.messages) {
    const finding = {
      rule: message.ruleId ?? 'eslint-config',
      file,
      line: message.line,
      column: message.column,
      message: message.message,
    }
    const allowed = allowance.counts?.[finding.rule]?.[file]
    if (assertionRules.has(finding.rule) && allowed !== undefined) interopFindings.push(finding)
    else if (message.severity >= 1) errors.push(finding)
  }
}

const actualInteropCounts = countsFromFindings(interopFindings)
for (const [rule, files] of Object.entries(actualInteropCounts)) {
  for (const [file, count] of Object.entries(files)) {
    const allowed = allowance.counts?.[rule]?.[file] ?? 0
    if (count > allowed) {
      errors.push({
        rule,
        file,
        line: 1,
        column: 1,
        message: `DSH interop 断言数量 ${count} 超过固定白名单 ${allowed}`,
      })
    }
  }
}

for (const error of errors) {
  console.error(`${error.file}:${error.line}:${error.column} ${error.rule}: ${error.message}`)
}

if (errors.length > 0) {
  process.exitCode = 1
} else {
  console.log(`ESLint passed (${interopFindings.length} fixed DSH interop assertions; all other assertions: 0).`)
}
