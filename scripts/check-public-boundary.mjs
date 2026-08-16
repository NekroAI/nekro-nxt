import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'

const repositoryFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean)

const forbiddenTrackedPrefixes = ['.local/', 'docs-private/', 'data/', 'secrets/']
const textExtensions = new Set([
  '',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.svg',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
])
const genericPatterns = [
  { name: 'macOS absolute user or volume path', pattern: /\/(?:Users|Volumes)\/[^\s"'`<>]+/g },
  { name: 'Linux absolute home path', pattern: /\/home\/[^\s"'`<>]+/g },
  { name: 'home-relative personal path', pattern: /~\/(?:Desktop|Documents|Downloads|Projects)\/[^\s"'`<>]+/g },
  { name: 'private key block', pattern: /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/g },
  { name: 'GitHub token', pattern: /(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { name: 'AWS access key', pattern: /AKIA[0-9A-Z]{16}/g },
  { name: 'OpenAI-style secret', pattern: /sk-[A-Za-z0-9_-]{20,}/g },
  { name: 'raw IPv4 address', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
]

const localPatternPath = '.local/forbidden-patterns.txt'
const localPatterns = existsSync(localPatternPath)
  ? readFileSync(localPatternPath, 'utf8')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
  : []

const findings = []

for (const path of repositoryFiles) {
  if (!existsSync(path)) continue

  if (forbiddenTrackedPrefixes.some((prefix) => path.startsWith(prefix))) {
    findings.push(`${path}: local/private path is part of the publish candidate`)
    continue
  }

  if (!textExtensions.has(extname(path).toLowerCase())) continue
  if (statSync(path).size > 2 * 1024 * 1024) continue

  const content = readFileSync(path, 'utf8')
  const lines = content.split(/\r?\n/u)

  for (const { name, pattern } of genericPatterns) {
    pattern.lastIndex = 0
    for (const match of content.matchAll(pattern)) {
      const line = content.slice(0, match.index).split('\n').length
      findings.push(`${path}:${line}: ${name}: ${match[0]}`)
    }
  }

  for (const forbidden of localPatterns) {
    const needle = forbidden.toLocaleLowerCase('en-US')
    lines.forEach((lineContent, index) => {
      if (lineContent.toLocaleLowerCase('en-US').includes(needle)) {
        findings.push(`${path}:${index + 1}: local forbidden pattern: ${forbidden}`)
      }
    })
  }
}

if (findings.length > 0) {
  console.error('Public boundary check failed:')
  for (const finding of findings) console.error(`- ${finding}`)
  process.exitCode = 1
} else {
  console.log(`Public boundary check passed (${repositoryFiles.length} candidate files).`)
}
