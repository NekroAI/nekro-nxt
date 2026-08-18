import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export function countsFromFindings(findings) {
  const counts = {}
  for (const finding of findings) {
    const byFile = (counts[finding.rule] ??= {})
    byFile[finding.file] = (byFile[finding.file] ?? 0) + 1
  }
  return sortCounts(counts)
}

export function sortCounts(counts) {
  return Object.fromEntries(
    Object.entries(counts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([rule, files]) => [
        rule,
        Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right))),
      ]),
  )
}

export function compareCounts(actual, baseline) {
  const regressions = []
  for (const [rule, files] of Object.entries(actual)) {
    for (const [file, count] of Object.entries(files)) {
      const allowed = baseline[rule]?.[file] ?? 0
      if (count > allowed) regressions.push({ rule, file, count, allowed })
    }
  }
  return regressions
}

export async function readBaseline(root, relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), 'utf8'))
}

export async function writeBaseline(root, relativePath, value) {
  await writeFile(path.join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`)
}
