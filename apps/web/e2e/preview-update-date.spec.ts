import { expect, test } from '@playwright/test'

for (const publishedAt of [Date.parse('2026-10-11T11:51:45Z'), undefined]) {
  test(`preview update date uses the returned rolling date (${publishedAt === undefined ? 'missing' : 'available'})`, async ({
    page,
  }) => {
    const failures: string[] = []
    page.on('pageerror', (error) => failures.push(error.message))
    await page.route('**/api/product/updates', (route) =>
      route.fulfill({
        json: {
          channel: 'preview',
          currentVersion: '0.4.0-20261010-010101utc.g111111111111',
          state: 'available',
          autoCheck: true,
          latest: {
            version: '0.5.0-20261011-114253utc.g222222222222',
            url: 'https://example.test/releases/preview',
            ...(publishedAt === undefined ? {} : { publishedAt }),
          },
        },
      }),
    )
    await page.goto('/settings/about')
    await expect(page.getByRole('heading', { name: '关于', exact: true })).toBeVisible()
    const update = page.getByText(/有新版本 0\.5\.0-/u)
    await expect(update).toBeVisible()
    if (publishedAt === undefined) await expect(update).not.toContainText('发布')
    else await expect(update).toContainText('2026/10/11 发布')
    await expect(update).not.toContainText('2026/8/23')
    expect(failures).toEqual([])
  })
}
