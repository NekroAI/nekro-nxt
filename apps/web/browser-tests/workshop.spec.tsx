import { AuthoringAttemptIdSchema, AuthoringTaskIdSchema } from '@nekro-nxt/contracts'
import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { createServer, type ViteDevServer } from 'vite'
import { installSnapshotHealthRoutes } from '../e2e/fixtures/host-release.js'
import {
  productSnapshot,
  sourceAgentId,
  summaryExtensionId,
  targetAgentId,
  targetChannelId,
  targetEpisodeId,
} from '../e2e/fixtures/product-quality.js'

/** A real, solid-coloured square PNG so the browser decodes it like a package icon. */
const solidPng = (size: number): Uint8Array => {
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), body.length + 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [63, 91, 143]).flat())])
  const pixels = deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', pixels),
    chunk('IEND', new Uint8Array()),
  ])
}

/** Workshop journeys against a stubbed Host: every `/api` call is answered here, never by a real service. */
test.describe('workshop', () => {
  test.describe.configure({ mode: 'default', timeout: 30_000 })
  let server: ViteDevServer
  let browser: Browser
  let baseUrl: string
  let cacheDirectory: string

  test.beforeAll(async () => {
    cacheDirectory = await mkdtemp(join(tmpdir(), 'nekro-workshop-spec-'))
    server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
      cacheDir: cacheDirectory,
      logLevel: 'silent',
      server: { host: '127.0.0.1', strictPort: false },
    })
    await server.listen()
    const address = server.httpServer?.address()
    if (!address || typeof address === 'string') throw new Error('Vite test server did not expose a TCP port.')
    baseUrl = `http://127.0.0.1:${address.port}`
    browser = await chromium.launch({ headless: true })
  })

  test.afterAll(async () => {
    await browser?.close()
    await server?.close()
    if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true })
  })

  const openWorkshop = async (snapshot: typeof productSnapshot): Promise<Page> => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    // Registered first so it has the lowest priority: anything not stubbed below fails loudly instead of leaking.
    await page.route('**/api/**', (route) =>
      route.fulfill({ status: 501, json: { error: { code: 'unstubbed', message: 'unstubbed' } } }),
    )
    await page.route('**/api/attention', (route) => route.fulfill({ json: { revision: 'fixture', items: [] } }))
    await installSnapshotHealthRoutes(page, snapshot)
    await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }))
    await page.route('**/api/events', (route) =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }),
    )
    await page.goto(`${baseUrl}/workshop`)
    return page
  }

  test('adds a remote MCP server after a connection test, keeping the token out of the extension', async () => {
    const page = await openWorkshop(productSnapshot)
    const requests: { path: string; body: unknown }[] = []
    await page.route('**/api/mcp-servers/test', async (route) => {
      requests.push({ path: 'test', body: route.request().postDataJSON() })
      await route.fulfill({
        json: {
          ok: true,
          message: '已连接，提供 2 个工具。',
          serverName: 'fixture',
          tools: [{ name: 'search_docs' }, { name: 'read_page' }],
        },
      })
    })
    await page.route('**/api/mcp-servers', async (route) => {
      requests.push({ path: 'create', body: route.request().postDataJSON() })
      await route.fulfill({
        json: {
          extensionId: summaryExtensionId,
          revisionId: 'xrv_mcpfixture',
          secretFields: [{ key: 'header_1', name: 'Authorization' }],
        },
      })
    })
    try {
      await page.getByRole('button', { name: '添加 MCP 服务' }).first().click()
      const dialog = page.getByRole('dialog', { name: '添加 MCP 服务' })
      await dialog.getByLabel('名称', { exact: true }).fill('示例知识库')
      await dialog.getByLabel('地址').fill('https://docs.example.com/mcp')
      await expect(dialog.getByLabel('工具前缀')).toHaveAttribute('placeholder', 'docs')
      await dialog.getByRole('button', { name: '添加', exact: true }).first().click()
      await dialog.getByLabel('请求头 1 名称').fill('Authorization')
      await dialog.getByLabel('请求头 1 值').fill('Bearer fixture-token')
      await dialog.getByRole('button', { name: '测试连接' }).click()
      await expect(dialog).toContainText('已连接，提供 2 个工具。')
      await expect(dialog).toContainText('search_docs')
      await dialog.getByRole('combobox', { name: '启用到' }).click()
      await page.getByRole('option', { name: '暂不启用' }).click()
      await page.screenshot({ path: '.local/browser-test-results/workshop-add-mcp.png' })
      await dialog.getByRole('button', { name: '添加', exact: true }).last().click()
      await expect.poll(() => requests.map(({ path }) => path)).toEqual(['test', 'create'])
      const server = {
        transport: 'streamable-http',
        name: 'docs',
        url: 'https://docs.example.com/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer fixture-token', secret: true }],
      }
      expect(requests[0]?.body).toEqual({ server })
      expect(requests[1]?.body).toEqual({
        displayName: '示例知识库',
        description: '',
        server: { ...server, headers: [{ name: 'Authorization', value: '', secret: true }] },
      })
      await expect(dialog).toBeHidden()
    } finally {
      await page.close()
    }
  })

  test('takes write-only test credentials for a running authoring task', async () => {
    const taskId = AuthoringTaskIdSchema.parse('aut_FIXTURETASK')
    const attempt = {
      id: AuthoringAttemptIdSchema.parse('aua_FIXTUREATTEMPT'),
      ordinal: 1,
      name: '天气查询',
      purpose: '查询实时天气。',
      state: 'active' as const,
      riskDigest: 'e'.repeat(64),
      host: { status: 'running' as const, waitingFor: [] },
      client: { status: 'absent' as const, waitingFor: [] },
      createdAt: 1_725_000_000_000,
    }
    const task = {
      id: taskId,
      agentId: targetAgentId,
      channelId: targetChannelId,
      episodeId: targetEpisodeId,
      title: '天气查询',
      requirementSummary: '按城市查询实时天气。',
      status: 'running' as const,
      approvalPolicy: 'risk-stable' as const,
      revision: 2,
      activeAttempt: attempt,
      candidateAttempt: attempt,
      createdAt: 1_725_000_000_000,
      updatedAt: 1_725_000_000_100,
    }
    const page = await openWorkshop({ ...productSnapshot, authoringTasks: [task] })
    let submitted: unknown
    await page.route(`**/api/authoring/tasks/${taskId}`, (route) =>
      route.fulfill({
        json: {
          task,
          attempts: [attempt],
          events: [],
          testSecrets: { fields: [{ key: 'apiKey', title: '高德 Key' }], configured: [] },
        },
      }),
    )
    await page.route(`**/api/authoring/tasks/${taskId}/test-secrets`, async (route) => {
      submitted = route.request().postDataJSON()
      await route.fulfill({ json: { configured: ['apiKey'] } })
    })
    try {
      await page.goto(`${baseUrl}/workshop/tasks/${taskId}`)
      const input = page.getByLabel('高德 Key')
      await expect(input).toBeVisible()
      const save = page.getByRole('button', { name: '保存测试凭据' })
      await expect(save).toBeDisabled()
      await input.fill('fixture-test-key')
      await page.screenshot({ path: '.local/browser-test-results/authoring-test-secrets.png' })
      await save.click()
      await expect.poll(() => submitted).toEqual({ secrets: { apiKey: 'fixture-test-key' } })
      await expect(input).toHaveValue('')
      await expect(input).toHaveAttribute('placeholder', '已保存，留空则不修改')
    } finally {
      await page.close()
    }
  })

  test('edits an agent extension credential without ever receiving the stored value', async () => {
    const snapshot = {
      ...productSnapshot,
      extensions: productSnapshot.extensions.map((extension) =>
        extension.id !== summaryExtensionId
          ? extension
          : {
              ...extension,
              revisions: extension.revisions.map((revision) => ({
                ...revision,
                agentConfigSchema: {
                  type: 'object' as const,
                  dict: {
                    city: { type: 'string' as const, meta: { description: '默认城市', default: '示例市' } },
                    apiKey: {
                      type: 'string' as const,
                      meta: { description: 'API Key', role: 'secret', required: true },
                    },
                  },
                },
              })),
              activations: extension.activations.map((activation) => ({
                ...activation,
                config: { city: '示例市' },
                configuredSecrets: ['apiKey'],
              })),
            },
      ),
    }
    const page = await openWorkshop(snapshot)
    let saved: unknown
    await page.route(
      `**/api/agents/${targetAgentId}/extensions/${summaryExtensionId}/activation/config`,
      async (route) => {
        saved = route.request().postDataJSON()
        await route.fulfill({ json: { config: { city: '另一市' }, configuredSecrets: ['apiKey'] } })
      },
    )
    try {
      await page.goto(`${baseUrl}/workshop/extensions/${summaryExtensionId}`)
      const secret = page.getByLabel('API Key')
      await expect(secret).toHaveValue('')
      await expect(secret).toHaveAttribute('placeholder', '已保存，留空则不修改')
      await page.getByLabel('默认城市').fill('另一市')
      await page.screenshot({ path: '.local/browser-test-results/extension-secret-config.png' })
      await page.getByRole('button', { name: '保存配置' }).click()
      await expect.poll(() => saved).toEqual({ config: { city: '另一市' } })

      await secret.fill('fixture-new-key')
      await page.getByRole('button', { name: '保存配置' }).click()
      // The stubbed snapshot never catches up, so the editor keeps the edited city; the typed key is cleared once saved.
      await expect.poll(() => saved).toEqual({ config: { city: '另一市' }, secrets: { apiKey: 'fixture-new-key' } })
      await expect(secret).toHaveValue('')
    } finally {
      await page.close()
    }
  })

  test('describes an MCP extension by the services it connects', async () => {
    const docsMcp = {
      servers: [
        {
          transport: 'streamable-http' as const,
          name: 'docs',
          url: 'https://docs.example.com/mcp',
          headers: { Authorization: { secret: 'header_1' } },
        },
      ],
    }
    const snapshot = {
      ...productSnapshot,
      extensions: productSnapshot.extensions.map((extension) =>
        extension.id !== summaryExtensionId
          ? extension
          : {
              ...extension,
              activations: extension.activations.map((activation) => ({
                ...activation,
                mcpServers: [
                  { name: 'docs', state: 'missing-credentials' as const, missing: ['Authorization'], observedAt: 1 },
                ],
              })),
              revisions: extension.revisions.map((revision) => ({
                ...revision,
                verification: {
                  verifiedAt: 1_725_000_000_000,
                  dshVersion: 'fixture',
                  contractVersion: 'nekro-nxt-extension-v5',
                  hostBuilt: true,
                  clientBuilt: false,
                  buildKey: 'fixture',
                  toolInvocationCount: 0,
                  rpcMethods: [],
                  renderedPanels: [],
                  renderedToolViews: [],
                  renderedMessageRenderers: [],
                  permissions: { permissions: [], networkOrigins: [], agent: { mcp: docsMcp } },
                  agentPermission: {
                    declaration: { permissions: [], networkOrigins: [], capabilities: { mcp: docsMcp } },
                    permissionDigest: 'e'.repeat(64),
                    approvalRequired: true,
                  },
                },
              })),
            },
      ),
    }
    const page = await openWorkshop(snapshot)
    try {
      await page.goto(`${baseUrl}/workshop/extensions/${summaryExtensionId}`)
      const overview = page.getByRole('region', { name: '能提供什么' })
      await expect(overview).toContainText('MCP 服务')
      await expect(overview).toContainText('mcp__docs__')
      await expect(overview).toContainText('远程 https://docs.example.com/mcp')
      await expect(overview).not.toContainText('还没有经过验证')
      await expect(page.getByRole('region', { name: '智能体' })).toContainText('缺少凭据：Authorization')
    } finally {
      await page.close()
    }
  })

  test('selects an imported extension although the list learns about it after the address does', async () => {
    const importedId = 'ext_imported'
    const summary = productSnapshot.extensions.find((extension) => extension.id === summaryExtensionId)
    if (!summary) throw new Error('fixture extension missing')
    const imported = {
      ...summary,
      id: importedId,
      slug: 'imported-one',
      displayName: '刚导入的扩展',
      activations: [],
    }
    let committed = false
    const page = await openWorkshop(productSnapshot)
    // The snapshot only includes the extension a moment after the commit returns, like a real Host refresh.
    await page.route('**/api/snapshot', async (route) => {
      if (committed) await new Promise((resolve) => setTimeout(resolve, 800))
      await route.fulfill({
        json: committed
          ? { ...productSnapshot, extensions: [...productSnapshot.extensions, imported] }
          : productSnapshot,
      })
    })
    await page.route('**/api/extensions/imports/inspect', (route) =>
      route.fulfill({
        json: {
          token: 'import-token',
          extensionId: importedId,
          revisionId: 'xrv_imported',
          slug: 'imported-one',
          displayName: '刚导入的扩展',
          provides: ['agent'],
          idempotent: false,
          slugConflict: false,
        },
      }),
    )
    await page.route('**/api/extensions/imports/import-token/commit', (route) => {
      committed = true
      return route.fulfill({ json: { extensionId: importedId, revisionId: 'xrv_imported', idempotent: false } })
    })
    try {
      await expect(page.getByRole('button', { name: '导入扩展' })).toBeVisible()
      await page
        .locator('input[type="file"]')
        .first()
        .setInputFiles({ name: 'imported.nxt-extension', mimeType: 'application/zip', buffer: Buffer.from('PK') })
      await page.getByRole('dialog').getByRole('button', { name: '导入', exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/workshop/extensions/${importedId}$`))
      await expect(page.locator('[aria-current="page"]', { hasText: '刚导入的扩展' })).toBeVisible()
    } finally {
      await page.close()
    }
  })

  test('shows the package icon of an extension in the list, its detail and the agent capabilities', async () => {
    const iconPath = `/api/extensions/${summaryExtensionId}/revisions/xrv_summary/icon/${'c'.repeat(64)}.png`
    const snapshot = {
      ...productSnapshot,
      extensions: productSnapshot.extensions.map((extension) =>
        extension.id !== summaryExtensionId
          ? extension
          : { ...extension, revisions: extension.revisions.map((revision) => ({ ...revision, iconUrl: iconPath })) },
      ),
    }
    const page = await openWorkshop(snapshot)
    const iconRequests: string[] = []
    await page.route(`**${iconPath}`, (route) => {
      iconRequests.push(route.request().url())
      return route.fulfill({ contentType: 'image/png', body: Buffer.from(solidPng(64)) })
    })
    try {
      await page.goto(`${baseUrl}/workshop/extensions/${summaryExtensionId}`)
      const icons = page.locator(`img[src="${iconPath}"]`)
      await expect(icons).toHaveCount(2)
      await expect.poll(() => icons.first().evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(64)
      expect(iconRequests.length).toBeGreaterThan(0)
      await page.screenshot({ path: '.local/browser-test-results/workshop-extension-icon.png' })
    } finally {
      await page.close()
    }
  })

  test('lists Host capabilities on enable approval and holds high-risk ones until accepted one by one', async () => {
    const digest = 'd'.repeat(64)
    const capabilities = {
      network: { mode: 'unrestricted' as const, purpose: '打开群友分享的任意链接并生成摘要' },
      storage: { scopes: ['agent' as const] },
      history: { read: true as const },
    }
    const snapshot = {
      ...productSnapshot,
      extensions: productSnapshot.extensions.map((extension) =>
        extension.id !== summaryExtensionId
          ? extension
          : {
              ...extension,
              activations: [],
              revisions: extension.revisions.map((revision) => ({
                ...revision,
                verification: {
                  verifiedAt: 1_725_000_000_000,
                  dshVersion: 'fixture',
                  contractVersion: 'nekro-nxt-extension-v5',
                  hostBuilt: true,
                  clientBuilt: false,
                  buildKey: 'fixture',
                  toolInvocationCount: 1,
                  rpcMethods: [],
                  renderedPanels: [],
                  renderedToolViews: [],
                  renderedMessageRenderers: [],
                  permissions: { permissions: [], networkOrigins: [], agent: capabilities },
                  agentPermission: {
                    declaration: { permissions: [], networkOrigins: [], capabilities },
                    permissionDigest: digest,
                    approvalRequired: true,
                  },
                },
              })),
            },
      ),
    }
    const page = await openWorkshop(snapshot)
    let approvedDigest: unknown
    await page.route(`**/api/agents/${targetAgentId}/extensions/${summaryExtensionId}/activation`, async (route) => {
      const body: unknown = route.request().postDataJSON()
      approvedDigest =
        typeof body === 'object' && body !== null && 'permissionApproval' in body ? body.permissionApproval : undefined
      // 启用需要一点时间：开关应先切到目标位置并显示进行中。
      await new Promise((resolve) => setTimeout(resolve, 600))
      const revisionId = snapshot.extensions.find((extension) => extension.id === summaryExtensionId)?.revisions[0]?.id
      const activation = {
        agentId: targetAgentId,
        extensionRevisionId: revisionId,
        config: {},
        activatedAt: 1_725_000_100_000,
      }
      // 之后的快照反映这次启用，开关才结束进行中。
      await page.route('**/api/snapshot', (snapshotRoute) =>
        snapshotRoute.fulfill({
          json: {
            ...snapshot,
            extensions: snapshot.extensions.map((extension) =>
              extension.id === summaryExtensionId ? { ...extension, activations: [activation] } : extension,
            ),
          },
        }),
      )
      await route.fulfill({ json: { activation: { ...activation, extensionId: summaryExtensionId } } })
    })
    try {
      await page.goto(`${baseUrl}/workshop/extensions/${summaryExtensionId}`)
      const usage = page.getByRole('switch', { name: /使用「群聊摘要」/u }).first()
      await usage.click()
      // 等待批准与启用期间，开关停在目标位置并显示进行中，不能再点（对话框打开时背后的页面不在无障碍树中，按属性定位）。
      const behindDialog = page.locator('[role="switch"][aria-label*="使用「群聊摘要」"]').first()
      await expect(behindDialog).toHaveAttribute('aria-busy', 'true')
      await expect(behindDialog).toHaveAttribute('data-state', 'checked')
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByText('为这个智能体保存数据')).toBeVisible()
      await expect(dialog.getByText('读取当前频道的聊天记录')).toBeVisible()
      const confirm = dialog.getByRole('button', { name: '允许并启用' })
      await expect(confirm).toBeDisabled()
      const risk = dialog.getByRole('switch', { name: '访问任意公网地址' })
      await expect(dialog).toContainText('用途：打开群友分享的任意链接并生成摘要。')
      await risk.click()
      await expect(risk).toHaveAttribute('data-state', 'checked')
      await expect(confirm).toBeEnabled()
      await page.waitForTimeout(300)
      await page.screenshot({ path: '.local/browser-test-results/capability-approval.png' })
      await confirm.click()
      await expect(dialog).toBeHidden()
      await expect(usage).not.toHaveAttribute('aria-busy', 'true')
      expect(approvedDigest).toEqual({ permissionDigest: digest })
    } finally {
      await page.close()
    }
  })

  test('keeps only the switching row busy while the agent is replying and shows a failed switch with its reason', async () => {
    const snapshot = {
      ...productSnapshot,
      extensions: productSnapshot.extensions.map((extension) =>
        extension.id !== summaryExtensionId
          ? extension
          : {
              ...extension,
              activationTransitions: [
                {
                  agentId: targetAgentId,
                  target: 'disabled' as const,
                  state: 'failed' as const,
                  message: '扩展卸载超时',
                  since: 1_725_000_200_000,
                },
              ],
            },
      ),
    }
    const page = await openWorkshop(snapshot)
    await page.route(`**/api/agents/${sourceAgentId}/extensions/${summaryExtensionId}/activation`, async (route) => {
      const since = 1_725_000_300_000
      const pending = { agentId: sourceAgentId, target: 'enabled' as const, state: 'waiting' as const, since }
      await page.route('**/api/snapshot', (snapshotRoute) =>
        snapshotRoute.fulfill({
          json: {
            ...snapshot,
            extensions: snapshot.extensions.map((extension) =>
              extension.id !== summaryExtensionId
                ? extension
                : { ...extension, activationTransitions: [...(extension.activationTransitions ?? []), pending] },
            ),
          },
        }),
      )
      await route.fulfill({ json: { pending } })
    })
    try {
      await page.goto(`${baseUrl}/workshop/extensions/${summaryExtensionId}`)
      const usage = page.getByRole('table', { name: '使用这个扩展的智能体' })
      await expect(usage.getByText('停用失败：扩展卸载超时')).toBeVisible()
      const waitingSwitch = page.getByRole('switch', { name: '记录员使用「群聊摘要」' })
      await waitingSwitch.click()
      await expect(usage.getByText('正在回复，结束后启用')).toBeVisible()
      await expect(waitingSwitch).toHaveAttribute('aria-busy', 'true')
      await expect(waitingSwitch).toHaveAttribute('data-state', 'checked')
      // 只有正在切换的那一行进入进行中，其他智能体的开关照常可用。
      const otherSwitch = page.getByRole('switch', { name: '资料员使用「群聊摘要」' })
      await expect(otherSwitch).not.toHaveAttribute('aria-busy', 'true')
      await expect(otherSwitch).toBeEnabled()
      // 旋转指示在短暂停顿后出现。
      await page.waitForTimeout(800)
      await waitingSwitch.screenshot({ path: '.local/browser-test-results/extension-activation-waiting-switch.png' })
      await page.screenshot({ path: '.local/browser-test-results/extension-activation-waiting.png' })
    } finally {
      await page.close()
    }
  })

  test('explains the empty workshop and starts an example in a creator channel with the request typed', async () => {
    const page = await openWorkshop({ ...productSnapshot, authoringTasks: [], extensions: [] })
    try {
      await expect(page.getByText('让智能体为你做新能力')).toBeVisible()
      const list = page.getByRole('complementary', { name: '工坊' })
      await expect(list.getByText('还没有创造任务')).toBeVisible()
      await expect(list.getByText(/还没有扩展/u)).toBeVisible()
      await expect(page.locator('main').getByRole('button', { name: '资料员', exact: true })).toBeVisible()
      await page.getByRole('button', { name: /让智能体多一项本领/u }).click()
      await expect(page).toHaveURL(new RegExp(`/channels/${targetChannelId}$`, 'u'))
      await expect(page.getByRole('textbox', { name: '消息' })).toHaveValue(/帮我做一个工具/u)
    } finally {
      await page.close()
    }
  })
})
