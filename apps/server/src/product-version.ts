import { readFileSync } from 'node:fs'

declare const __NEKRO_PRODUCT_VERSION__: string

const PRODUCT_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u

const readSourceProductVersion = (): string => {
  const manifestSource = readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')
  const version = /^\s*"version"\s*:\s*"([^"]+)"/mu.exec(manifestSource)?.[1]
  if (version === undefined || !PRODUCT_VERSION_PATTERN.test(version)) {
    throw new TypeError('根 package.json 缺少有效产品版本。')
  }
  return version
}

export const PRODUCT_VERSION =
  typeof __NEKRO_PRODUCT_VERSION__ === 'string' ? __NEKRO_PRODUCT_VERSION__ : readSourceProductVersion()
