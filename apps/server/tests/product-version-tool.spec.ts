import { describe, expect, it } from 'vitest'
import { productVersionInfo, productVersionTool } from '../src/product-version-tool.js'
import { PRODUCT_VERSION } from '../src/product-version.js'

describe('nekro_nxt_version', () => {
  it('takes no parameters', () => {
    const tool = productVersionTool(undefined)
    expect(tool.name).toBe('nekro_nxt_version')
    expect(tool.parameters).toMatchObject({ type: 'object', properties: {} })
  })

  it('reports a preview build with its full release id', () => {
    expect(productVersionInfo('0.9.0-20991231-120000utc.gabcdef123456+abcdef123456')).toEqual({
      version: PRODUCT_VERSION,
      build: '0.9.0-20991231-120000utc.gabcdef123456+abcdef123456',
      channel: 'preview',
    })
  })

  it('reports a stable build', () => {
    expect(productVersionInfo('0.9.0+abcdef123456')).toEqual({
      version: PRODUCT_VERSION,
      build: '0.9.0+abcdef123456',
      channel: 'stable',
    })
  })

  it('leaves the build empty for a source checkout', () => {
    expect(productVersionInfo(`@nekro-nxt/server@${PRODUCT_VERSION}`)).toEqual({
      version: PRODUCT_VERSION,
      build: null,
      channel: 'development',
    })
  })

  it('leaves build and channel empty without a release id', () => {
    expect(productVersionInfo(undefined)).toEqual({ version: PRODUCT_VERSION, build: null, channel: null })
  })
})
