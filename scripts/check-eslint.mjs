import { ESLint } from 'eslint'

const eslint = new ESLint()
const results = await eslint.lintFiles(['.'])
const formatter = await eslint.loadFormatter('stylish')
const output = formatter.format(results)
if (output) console.error(output)
if (results.some((result) => result.errorCount || result.warningCount)) process.exitCode = 1
else console.log('ESLint passed.')
