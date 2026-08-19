import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const root = process.cwd()
const specPattern = /\.spec\.(?:ts|tsx)$/u
const playwrightImport = /from\s+['"]@playwright\/test['"]/u
const vitestRoots = ['apps', 'packages', 'scripts']

async function collectPlaywrightVitestFiles(directory) {
  const files = []
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return files
    throw error
  }

  for (const entry of entries) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'e2e' || entry.name === 'node_modules') continue
      files.push(...(await collectPlaywrightVitestFiles(target)))
      continue
    }
    if (!specPattern.test(entry.name)) continue
    const text = await readFile(target, 'utf8')
    if (playwrightImport.test(text)) {
      files.push(path.relative(root, target).split(path.sep).join('/'))
    }
  }
  return files
}

test('coverage and node-compat skip Playwright-in-vitest files', async () => {
  const files = []
  for (const directory of vitestRoots) {
    files.push(...(await collectPlaywrightVitestFiles(path.join(root, directory))))
  }
  files.sort()
  assert.ok(files.length > 0, 'expected at least one Playwright-in-vitest file')

  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const coverageScript = packageJson.scripts['test:coverage']
  const ciYml = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8')

  const missingFromCoverage = files.filter((file) => !coverageScript.includes(`--exclude ${file}`))
  const missingFromCompat = files.filter((file) => !ciYml.includes(`--exclude ${file}`))

  assert.deepEqual(missingFromCoverage, [], 'test:coverage must exclude Playwright-in-vitest files')
  assert.deepEqual(missingFromCompat, [], 'node-compat must exclude Playwright-in-vitest files')
  assert.match(ciYml, /playwright install --with-deps chromium chromium-headless-shell/u)
})
