import { installSnapshotHealthRoutes } from './fixtures/host-release.js'
import { installWorkspaceRoutes } from './fixtures/workspace.js'
import { expect, test } from '@playwright/test'
import { ConnectionIdSchema, HostApiContracts } from '@nekro-nxt/contracts'
import { productSnapshot } from './fixtures/product-quality.js'

const connectionId = ConnectionIdSchema.parse('con_qrfixture')
const adapterKey = 'fixture-qr'
const descriptor = {
  key: adapterKey,
  displayName: '扫码测试平台',
  description: '虚构扫码平台',
  provisioning: 'user-created',
  aliasEditable: true,
  channelDiscovery: 'adapter-observed',
  channelKinds: ['direct'],
  activities: [],
  features: {},
  diagnostics: { receive: true, send: true },
  creation: { mode: 'qr-login', actionLabel: '扫码登录' },
  configSchema: {
    type: 'object',
    dict: { enableInboundMedia: { type: 'boolean', meta: { description: '入站媒体接收', default: true } } },
  },
}

test('production QR login and reauthentication retain the connection settings', async ({ page }, testInfo) => {
  await installSnapshotHealthRoutes(page, productSnapshot)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  let created = false
  let mediaEnabled = true
  let confirmed = false
  const starts: unknown[] = []
  await page.route('**/api/events', (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': fixture\n\n' }),
  )
  const snapshot = () =>
    HostApiContracts.snapshot.parseResponse({
      ...productSnapshot,
      connectionAdapters: [...productSnapshot.connectionAdapters, descriptor],
      connections: [
        ...productSnapshot.connections,
        ...(created
          ? [
              {
                id: connectionId,
                adapterKey,
                activityTriggerDefaults: [],
                status: { state: 'connected', proactiveSend: false, credentialConfigured: true, activities: {} },
                channelCount: 0,
                knownChannels: [],
                configuration: { enableInboundMedia: mediaEnabled },
              },
            ]
          : []),
      ],
    })
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot() }))
  await installWorkspaceRoutes(page, snapshot)
  await page.route('**/api/connection-logins', (route) => {
    starts.push(route.request().postDataJSON())
    confirmed = false
    return route.fulfill({
      status: 201,
      json: {
        loginId: 'fixture-login',
        adapterKey,
        status: 'pending',
        qrCodeUrl: 'https://example.invalid/fixture-qr',
      },
    })
  })
  await page.route('**/api/connection-logins/fixture-login', (route) => {
    if (route.request().method() === 'DELETE')
      return route.fulfill({ json: { loginId: 'fixture-login', status: 'cancelled' } })
    if (confirmed) created = true
    return route.fulfill({
      json: {
        loginId: 'fixture-login',
        adapterKey,
        status: confirmed ? 'confirmed' : 'pending',
        ...(confirmed ? { connectionId } : {}),
      },
    })
  })
  await page.route(`**/api/connections/${connectionId}/configuration`, (route) => {
    const body = HostApiContracts.updateConnectionConfiguration.parseRequest(route.request().postDataJSON())
    mediaEnabled = Boolean(body.configuration['enableInboundMedia'])
    return route.fulfill({ json: { connectionId, configuration: { enableInboundMedia: mediaEnabled } } })
  })
  await page.goto(`/wiring/new?adapter=${adapterKey}`)
  await expect(page.getByRole('heading', { name: '添加扫码测试平台账号' })).toBeVisible()
  await page.getByRole('button', { name: '扫码登录', exact: true }).click()
  const qr = page.getByRole('img', { name: '扫码测试平台登录二维码' })
  await expect(qr).toBeVisible()
  expect(starts).toEqual([{ adapterKey }])
  await page.screenshot({ path: testInfo.outputPath('qr-login.png'), animations: 'disabled' })
  confirmed = true
  await expect(page).toHaveURL(new RegExp(`/wiring/connections/${connectionId}$`, 'u'))
  const toggle = page.getByRole('switch', { name: '入站媒体接收' })
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await page.getByRole('button', { name: '重新扫码登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '重新登录扫码测试平台' })).toBeVisible()
  await page.getByRole('button', { name: '扫码登录', exact: true }).click()
  await expect(qr).toBeVisible()
  expect(starts).toEqual([{ adapterKey }, { adapterKey, connectionId }])
  confirmed = true
  await expect(page).toHaveURL(new RegExp(`/wiring/connections/${connectionId}$`, 'u'))
  await expect(toggle).not.toBeChecked()
  await toggle.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('reauthenticated-settings.png'), animations: 'disabled' })
  expect(errors).toEqual([])
})
