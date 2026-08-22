export const DSH_RELEASE_VERSION = '0.1.1-rc.2'
export const DSH_CORDIS_VERSION = '4.0.1'
export const DSH_LOADER_VERSION = '1.0.2'

// These two framework adapters stopped publishing after rc.7 while the rc.1
// Web app moved to dsh-client-ui-renderer. NekroNxt keeps them only for its
// current product-island renderer/settings fallback and removes them when the
// rc.2 product Client runtime replaces that seam.
export const DSH_RELEASE_EXCEPTIONS = new Map([
  ['@deepseek-ai/dsh-client-schema-form', '0.1.0-rc.7'],
  ['@deepseek-ai/dsh-client-web-react', '0.1.0-rc.7'],
])

export const expectedDshVersion = (packageName) => DSH_RELEASE_EXCEPTIONS.get(packageName) ?? DSH_RELEASE_VERSION
