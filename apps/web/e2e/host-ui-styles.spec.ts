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
    // The extension's own detail page opens the installed page it contributes.
    await page.goto(`/workshop/extensions/${fixture.extensionId}`)
    const open = page.getByRole('button', { name: `打开「${entry!.title}」` })
    await expect(open).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('host-ui-styles-workshop.png'), fullPage: true })
    await open.click()
    await expect(page).toHaveURL(new RegExp(`${entry!.routeBase}(?:/|$)`))
    const probe = page.locator('[data-styles-probe]')
    for (let load = 0; load < 2; load += 1) {
      if (load > 0) await page.reload()
      await expect(probe).toBeVisible()
      // V6 inserts the page's own stylesheet; the probe keeps the declared geometry after save and refresh.
      await expect(probe.getByRole('heading', { name: '样式回归页面' })).toBeVisible()
      await expect(probe.getByText('保存后样式正常')).toBeVisible()
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

test('mobile extension page navigation remains reachable after selection, reload and return', async ({
  page,
  request,
}, testInfo) => {
  const definition = {
    kind: 'host-page' as const,
    entryId: 'navigation-probe',
    title: '虚构导航页面',
    icon: { kind: 'host-icon' as const, name: 'layout-dashboard' as const },
    objectPane: 'navigation' as const,
    startPath: '',
  }
  const fixture = createStylesArchive(randomUUID().replaceAll('-', ''), {
    name: '虚构导航页面',
    purpose: '验证手机页面的导航与返回。',
    permissions: { permissions: [], networkOrigins: [] },
    contributions: [definition],
    clientCode: `return { inject: ['pages', 'ui'], apply(ctx) { return ctx.pages.register({ page: ${JSON.stringify(definition)}, navigation: { getSnapshot: () => ({ revision: 0, groups: [{ id: 'main', items: [{ id: 'first', label: '虚构页面甲', path: 'first' }, { id: 'second', label: '虚构页面乙', path: 'second' }] }] }), subscribe: () => () => undefined } }, ({ relativePath }) => React.createElement(ctx.ui.Section, {}, React.createElement('h2', {}, '虚构详情 ' + relativePath))) } }`,
  })
  const inspection = HostApiContracts.inspectExtensionImport.parseResponse(
    await (
      await request.post('/api/extensions/imports/inspect', {
        data: Buffer.from(fixture.archive),
        headers: { 'content-type': 'application/octet-stream' },
      })
    ).json(),
  )
  expect((await request.post(`/api/extensions/imports/${inspection.token}/commit`, { data: {} })).ok()).toBe(true)
  expect(
    (
      await request.put(`/api/extensions/${fixture.extensionId}/installation`, {
        data: { revisionId: fixture.revisionId },
      })
    ).ok(),
  ).toBe(true)
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(error.message))
  try {
    const snapshot = HostApiContracts.snapshot.parseResponse(await (await request.get('/api/snapshot')).json())
    const entry = snapshot.hostUi.pages.find(
      (item) => item.owner.kind === 'extension' && item.owner.extensionId === fixture.extensionId,
    )!
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(entry.routeBase)
    await page.getByRole('button', { name: '虚构页面甲', exact: true }).click()
    await expect(page.getByRole('heading', { name: '虚构详情 first', exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('heading', { name: '虚构详情 first', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '返回列表', exact: true }).click()
    await expect(page.getByRole('button', { name: '虚构页面乙', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('extension-navigation-mobile.png') })
    await page.getByRole('button', { name: '虚构页面乙', exact: true }).click()
    await expect(page.getByRole('heading', { name: '虚构详情 second', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(failures).toEqual([])
  } finally {
    await page.goto('about:blank')
    expect((await request.delete(`/api/extensions/${fixture.extensionId}/installation`)).ok()).toBe(true)
    expect((await request.delete(`/api/extensions/${fixture.extensionId}`)).ok()).toBe(true)
  }
})

for (const objectPane of ['hidden', 'navigation'] as const) {
  test(`tall extension page scrolls inside its viewport (${objectPane})`, async ({ page, request }, testInfo) => {
    const definition = {
      kind: 'host-page' as const,
      entryId: 'scroll-probe',
      title: '虚构长页面',
      icon: { kind: 'host-icon' as const, name: 'layout-dashboard' as const },
      objectPane,
      startPath: objectPane === 'navigation' ? 'list' : '',
    }
    const navigation =
      objectPane === 'navigation'
        ? `, navigation: { getSnapshot: () => ({ revision: 0, groups: [{ id: 'main', items: [{ id: 'list', label: '虚构列表', path: 'list' }] }] }), subscribe: () => () => undefined }`
        : ''
    const fixture = createStylesArchive(randomUUID().replaceAll('-', ''), {
      name: '虚构长页面',
      purpose: '验证内容超出一屏时页面可以滚动。',
      permissions: { permissions: [], networkOrigins: [] },
      contributions: [definition],
      clientCode: `return { inject: ['pages', 'ui'], apply(ctx) { return ctx.pages.register({ page: ${JSON.stringify(definition)}${navigation} }, () => React.createElement('div', {}, Array.from({ length: 80 }, (_, index) => React.createElement('p', { key: index, style: { height: '40px', margin: 0 } }, '虚构条目 ' + (index + 1))))) } }`,
    })
    const inspection = HostApiContracts.inspectExtensionImport.parseResponse(
      await (
        await request.post('/api/extensions/imports/inspect', {
          data: Buffer.from(fixture.archive),
          headers: { 'content-type': 'application/octet-stream' },
        })
      ).json(),
    )
    expect((await request.post(`/api/extensions/imports/${inspection.token}/commit`, { data: {} })).ok()).toBe(true)
    expect(
      (
        await request.put(`/api/extensions/${fixture.extensionId}/installation`, {
          data: { revisionId: fixture.revisionId },
        })
      ).ok(),
    ).toBe(true)
    try {
      const snapshot = HostApiContracts.snapshot.parseResponse(await (await request.get('/api/snapshot')).json())
      const entry = snapshot.hostUi.pages.find(
        (item) => item.owner.kind === 'extension' && item.owner.extensionId === fixture.extensionId,
      )!
      await page.setViewportSize({ width: 1280, height: 720 })
      await page.goto(entry.routeBase)
      const last = page.getByText('虚构条目 80', { exact: true })
      await expect(page.getByText('虚构条目 1', { exact: true })).toBeVisible()
      // The viewport is the page's own scroller: it must stop at the window instead of growing with the content.
      const viewport = page.locator(`[data-host-ui-page="${entry.pageInstanceId}"]`)
      const box = await viewport.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      }))
      expect(box.clientHeight).toBeLessThan(720)
      expect(box.scrollHeight).toBeGreaterThan(box.clientHeight)
      await viewport.hover()
      await page.mouse.wheel(0, 10_000)
      await expect(last).toBeInViewport()
      await page.screenshot({ path: testInfo.outputPath(`extension-scroll-${objectPane}.png`) })
    } finally {
      await page.goto('about:blank')
      expect((await request.delete(`/api/extensions/${fixture.extensionId}/installation`)).ok()).toBe(true)
      expect((await request.delete(`/api/extensions/${fixture.extensionId}`)).ok()).toBe(true)
    }
  })
}
