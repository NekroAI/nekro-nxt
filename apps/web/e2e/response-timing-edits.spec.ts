import { expect, test } from '@playwright/test'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { productSnapshot, targetChannelId } from './fixtures/product-quality.js'
import { installSnapshotHealthRoutes } from './fixtures/host-release.js'
import { installWorkspaceRoutes } from './fixtures/workspace.js'

const snapshot = HostApiContracts.snapshot.parseResponse(productSnapshot)

test('a second response-timing edit made before the saved binding comes back keeps the first', async ({ page }) => {
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(error.message))
  await installSnapshotHealthRoutes(page, snapshot)
  await installWorkspaceRoutes(page, () => snapshot)
  // The snapshot never catches up, like a Host that is slow to publish the saved binding.
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }))
  const saved: unknown[] = []
  await page.route('**/api/bindings', async (route) => {
    const input = HostApiContracts.createBinding.request.parse(route.request().postDataJSON())
    saved.push(input.responseTiming)
    await route.fulfill({ status: 201, json: { ...input, boundAt: 2 } })
  })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(`/channels/${targetChannelId}`)

  const quiet = page.getByRole('spinbutton', { name: '每次最多等（秒）' })
  const total = page.getByRole('spinbutton', { name: '一共最多等（秒）' })
  await quiet.fill('90')
  await quiet.press('Enter')
  await expect.poll(() => saved.length).toBe(1)
  await total.fill('200')
  await total.press('Enter')
  await expect.poll(() => saved.at(-1)).toEqual({ waitMaxQuietSeconds: 90, waitMaxTotalSeconds: 200 })
  await expect(quiet).toHaveValue('90')
  expect(failures).toEqual([])
})
