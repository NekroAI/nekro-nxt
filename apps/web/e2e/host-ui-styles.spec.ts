import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { createStylesArchive } from '../../../packages/extension-runtime/tests/fixtures/host-ui-styles-archive.js'

// The production server uses the Playwright synthetic data root. Generation is
// deterministic materialization, not a model conversation or a mocked module URL.
test('materialized Host UI styles survive durable save, installation and refresh', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(60_000)
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(error.message))
  const fixture = createStylesArchive(randomUUID().replaceAll('-', ''))
  const inspectionResponse = await request.post('/api/extensions/imports/inspect', {
    data: Buffer.from(fixture.archive),
    headers: { 'content-type': 'application/octet-stream' },
  })
  expect(inspectionResponse.ok(), await inspectionResponse.text()).toBe(true)
  const inspection = HostApiContracts.inspectExtensionImport.parseResponse(await inspectionResponse.json())
  const saveResponse = await request.post(`/api/extensions/imports/${encodeURIComponent(inspection.token)}/commit`, {
    data: {},
  })
  expect(saveResponse.ok(), await saveResponse.text()).toBe(true)

  const beforeInstall = HostApiContracts.snapshot.parseResponse(await (await request.get('/api/snapshot')).json())
  expect(
    beforeInstall.hostUi.pages.some(
      (entry) => entry.owner.kind === 'extension' && entry.owner.extensionId === fixture.extensionId,
    ),
  ).toBe(false)
  const installResponse = await request.put(`/api/extensions/${fixture.extensionId}/installation`, {
    data: { revisionId: fixture.revisionId },
  })
  expect(installResponse.ok(), await installResponse.text()).toBe(true)
  try {
    const installed = HostApiContracts.snapshot.parseResponse(await (await request.get('/api/snapshot')).json())
    const entry = installed.hostUi.pages.find(
      (candidate) => candidate.owner.kind === 'extension' && candidate.owner.extensionId === fixture.extensionId,
    )
    expect(entry).toBeDefined()
    await page.goto(entry!.routeBase)
    const probe = page.locator('[data-styles-probe]')
    for (let load = 0; load < 2; load += 1) {
      if (load > 0) await page.reload()
      await expect(probe).toBeVisible()
      await expect(probe.getByRole('heading', { name: '样式回归页面' })).toHaveClass('nxt-extension-section-heading')
      await expect(probe.getByText('保存后样式正常')).toHaveClass('nxt-extension-secondary-text')
      await expect(probe).toHaveCSS('padding-top', '23px')
      await expect(probe).toHaveCSS('border-radius', '17px')
      // The first click commits to the Host's owner-scoped state. After a real
      // document reload the Client must restore that value, then remain usable.
      await expect(probe.locator('[data-styles-counter]')).toHaveText(String(load))
      await probe.getByRole('button', { name: '增加计数' }).click()
      await expect(probe.locator('[data-styles-counter]')).toHaveText(String(load + 1))
      const stored = await request.post(`/api/host-ui/pages/${entry!.pageInstanceId}/call`, {
        data: { method: 'state.get', input: { key: 'counter' } },
      })
      expect(stored.ok(), await stored.text()).toBe(true)
      expect(HostApiContracts.callHostUiPage.parseResponse(await stored.json())).toMatchObject({
        value: { value: load + 1 },
      })
      await expect(probe.getByRole('alert')).toHaveCount(0)
      await expect(page.getByText('styles is not defined', { exact: false })).toHaveCount(0)
      await page.screenshot({
        path: testInfo.outputPath(`host-ui-styles-${load === 0 ? 'installed' : 'refreshed'}.png`),
        fullPage: true,
      })
    }
    // No permission was declared; loading a styled page must not grant Host access.
    const denied = await request.post(`/api/host-ui/pages/${entry!.pageInstanceId}/call`, {
      data: { method: 'agents.list', input: {} },
    })
    expect(denied.ok()).toBe(false)
    expect(await denied.text()).toContain('页面未获得 agents.read 权限。')
    expect(failures).toEqual([])
  } finally {
    const uninstall = await request.delete(`/api/extensions/${fixture.extensionId}/installation`)
    expect(uninstall.ok(), await uninstall.text()).toBe(true)
    const deleted = await request.delete(`/api/extensions/${fixture.extensionId}`)
    expect(deleted.ok(), await deleted.text()).toBe(true)
  }
})
