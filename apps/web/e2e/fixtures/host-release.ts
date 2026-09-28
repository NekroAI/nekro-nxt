import type { Page } from '@playwright/test'
import type { HostApiResponse } from '@nekro-nxt/contracts'

/** Match a production bundle identity when the runner supplies one, otherwise use a fictional Host. */
export const fixtureReleaseId = process.env['NEKRO_RELEASE_ID']?.trim() || 'nxt-synthetic-release'

/** A mocked snapshot and its health endpoint are the same Host, never different releases. */
export async function installSnapshotHealthRoutes(
  page: Page,
  snapshot:
    Pick<HostApiResponse<'snapshot'>, 'productMetadata'> | (() => Pick<HostApiResponse<'snapshot'>, 'productMetadata'>),
): Promise<void> {
  for (const status of ['live', 'ready'] as const) {
    await page.route(`**/health/${status}`, (route) => {
      const current = typeof snapshot === 'function' ? snapshot() : snapshot
      const releaseId = current.productMetadata?.releaseId
      if (!releaseId)
        throw new Error('A synthetic Host must declare the release used by its snapshot and health routes.')
      return route.fulfill({ json: { status, releaseId }, headers: { 'cache-control': 'no-store' } })
    })
  }
}
