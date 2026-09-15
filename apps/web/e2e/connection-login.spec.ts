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
    schemaVersion: 1,
    type: 'object',
    required: [],
    properties: {
      enableInboundMedia: { type: 'boolean', title: '入站媒体接收', default: true },
    },
  },
}

test('production QR login and reauthentication retain the connection settings', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  let created = false
  let mediaEnabled = true
  let confirmed = false
  const starts: unknown[] = []
  await page.route('**/api/events', (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': fixture\n\n' }),
  )
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({
      json: HostApiContracts.snapshot.parseResponse({
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
      }),
    }),
  )
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
  await page.goto('/connections?create=1&adapter=fixture-qr')
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: '扫码登录', exact: true }).click()
  await expect(dialog.getByRole('img', { name: '扫码测试平台 扫码登录二维码' })).toBeVisible()
  expect(starts).toEqual([{ adapterKey }])
  await page.screenshot({ path: testInfo.outputPath('qr-login.png'), animations: 'disabled' })
  confirmed = true
  await expect(dialog).not.toBeVisible()
  await page.goto(`/connections/${connectionId}`)
  const toggle = page.getByRole('switch', { name: '入站媒体接收' })
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await page.getByRole('button', { name: '重新认证', exact: true }).click()
  await dialog.getByRole('button', { name: '重新扫码认证', exact: true }).click()
  await expect(dialog.getByRole('img', { name: '扫码测试平台 扫码登录二维码' })).toBeVisible()
  expect(starts).toEqual([{ adapterKey }, { adapterKey, connectionId }])
  confirmed = true
  await expect(dialog).not.toBeVisible()
  await expect(toggle).not.toBeChecked()
  await toggle.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('reauthenticated-settings.png'), animations: 'disabled' })
  expect(errors).toEqual([])
})
