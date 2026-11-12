import type { ProductUpdateStatus } from '@nekro-nxt/contracts'
import { DOCS_ROUTES } from './docs-routes.js'

const DOCS = 'https://nxt.nekro.ai/docs'

/**
 * The documentation page for where the user is (docs/site page headers' `routes`), or the documentation home. Stable
 * builds read the stable documentation; preview and development builds read Preview, which matches their interface.
 */
/** A stable-channel documentation address, moved to Preview for builds that read Preview. */
export const docsForBuild = (href: string, channel: ProductUpdateStatus['channel'] | undefined): string =>
  channel === undefined || channel === 'stable' || !href.startsWith(`${DOCS}/`)
    ? href
    : `${DOCS}/preview/${href.slice(DOCS.length + 1)}`

export const docsHelpHref = (pathname: string, channel: ProductUpdateStatus['channel'] | undefined): string => {
  const page = DOCS_ROUTES.find(([route]) => pathname === route || pathname.startsWith(`${route}/`))?.[1]
  const base = channel === undefined || channel === 'stable' ? DOCS : `${DOCS}/preview`
  return page === undefined ? base : `${base}/${page}`
}
