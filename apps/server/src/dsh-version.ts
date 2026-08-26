import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const DSH_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

const readInstalledDshVersion = (): string => {
  const require = createRequire(import.meta.url)
  const manifestPath = require.resolve('@deepseek-ai/dsh-agent/package.json')
  const manifestSource = readFileSync(manifestPath, 'utf8')
  const version = /^\s*"version"\s*:\s*"([^"]+)"/mu.exec(manifestSource)?.[1]
  if (version === undefined || !DSH_VERSION_PATTERN.test(version)) {
    throw new TypeError('@deepseek-ai/dsh-agent 缺少有效版本。')
  }
  return version
}

export const DEEPSEEK_HARNESS_VERSION = readInstalledDshVersion()
