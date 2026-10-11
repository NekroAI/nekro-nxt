import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import {
  CommunityFeedbackCreateSchema,
  CommunityFeedbackMessageInputSchema,
  CommunityFeedbackReopenSchema,
  CommunityFeedbackSchema,
  CommunityFeedbackSummarySchema,
  CommunityFeedbackWithdrawSchema,
  HostApiContracts,
  type CommunityFeedback,
  type CommunityFeedbackEvent,
} from '@nekro-nxt/contracts'
import { expect, test } from '@playwright/test'

test('feedback production journey: login, consent, preview, community updates, reopen and withdrawal', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000)
  let item: CommunityFeedback | undefined
  const events: CommunityFeedbackEvent[] = []
  let sequence = 0
  const messageBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      if (!Buffer.isBuffer(chunk)) throw new TypeError('Fixture request requires byte chunks.')
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  }
  const current = () => {
    if (!item) throw new Error('Feedback fixture not created.')
    return item
  }
  const event = (
    type: CommunityFeedbackEvent['type'],
    data: CommunityFeedbackEvent['data'],
    actorKind: CommunityFeedbackEvent['actorKind'] = 'admin',
  ) => {
    const feedback = current()
    sequence += 1
    events.push({
      seq: sequence,
      ref: feedback.ref,
      type,
      data,
      actorKind,
      actor: actorKind === 'user' ? 'sample-author' : 'sample-reviewer',
      createdAt: Date.now(),
      title: feedback.title,
      status: feedback.status,
    })
    feedback.events = [...events]
    feedback.updatedAt = Date.now()
  }
  const json = (res: ServerResponse, body: unknown) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/oauth/authorize') {
      const callback = new URL(url.searchParams.get('redirect_uri')!)
      callback.searchParams.set('state', url.searchParams.get('state')!)
      callback.searchParams.set('code', 'browser-fixture-code')
      res.writeHead(302, { location: callback.toString() })
      res.end()
      return
    }
    if (url.pathname === '/oauth/token') {
      json(res, {
        access_token: 'nxtc_at_browser_fixture',
        refresh_token: 'nxtc_rt_browser_fixture',
        token_type: 'Bearer',
        expires_in: 3600,
        user: { id: 'usr_browser_fixture', handle: 'sample-author', displayName: '样例作者', avatarUrl: null },
      })
      return
    }
    if (url.pathname === '/oauth/revoke') {
      json(res, {})
      return
    }
    if (url.pathname === '/api/v1/meta') {
      json(res, { name: '虚构反馈社区', environment: 'development', version: 'fixture', features: ['feedback'] })
      return
    }
    if (url.pathname === '/api/v1/feedback/changes') {
      const cursor = url.searchParams.get('cursor')
      json(res, {
        events: cursor === null ? [] : events.filter((entry) => entry.seq > Number(cursor)),
        cursor: sequence,
        hasMore: false,
      })
      return
    }
    if (url.pathname === '/api/v1/feedback' && req.method === 'POST') {
      const input = CommunityFeedbackCreateSchema.parse(await messageBody(req))
      item = CommunityFeedbackSchema.parse({
        id: 'fbk_00000000000000000000000001',
        ref: 'FB-1',
        title: input.title,
        kind: input.kind,
        target: input.target,
        status: 'new',
        fixedIn: null,
        affectedCount: 0,
        confirmedCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        access: 'owner',
        body: input.body,
        diagnostics: input.diagnostics,
        excerpt: input.excerpt ?? null,
        messages: [],
        events: [],
      })
      event('created', {}, 'user')
      json(res, item)
      return
    }
    if (url.pathname === '/api/v1/feedback') {
      json(res, { items: item ? [CommunityFeedbackSummarySchema.parse(item)] : [], cursor: null })
      return
    }
    if (url.pathname === '/api/v1/feedback/FB-1') {
      json(res, current())
      return
    }
    if (url.pathname === '/api/v1/feedback/FB-1/messages') {
      const input = CommunityFeedbackMessageInputSchema.parse(await messageBody(req))
      const id = `fmsg_fixture${sequence + 1}`
      current().messages = [
        ...(current().messages ?? []),
        {
          id,
          authorKind: 'user',
          author: 'sample-author',
          audience: 'everyone',
          body: input.body,
          createdAt: Date.now(),
        },
      ]
      event('message', { messageId: id, audience: 'everyone' }, 'user')
      json(res, current())
      return
    }
    if (url.pathname === '/api/v1/feedback/FB-1/confirm-fixed') {
      current().confirmed = true
      current().confirmedCount = 1
      event('fix_confirmed', {}, 'user')
      json(res, current())
      return
    }
    if (url.pathname === '/api/v1/feedback/FB-1/reopen') {
      const input = CommunityFeedbackReopenSchema.parse(await messageBody(req))
      const before = current().status
      current().status = 'new'
      current().closedAt = null
      current().fixedIn = null
      const id = `fmsg_fixture${sequence + 1}`
      current().messages = [
        ...(current().messages ?? []),
        {
          id,
          authorKind: 'user',
          author: 'sample-author',
          audience: 'everyone',
          body: input.note,
          createdAt: Date.now(),
        },
      ]
      event('status_changed', { from: before, to: 'new' }, 'user')
      event('reopened', { messageId: id }, 'user')
      json(res, current())
      return
    }
    if (url.pathname === '/api/v1/feedback/FB-1/withdraw') {
      const input = CommunityFeedbackWithdrawSchema.parse(await messageBody(req))
      const before = current().status
      current().status = 'withdrawn'
      current().diagnostics = {}
      current().excerpt = null
      if (input.deleteText) {
        current().title = '已删除'
        current().body = ''
        current().messages = current().messages?.map((message) =>
          message.authorKind === 'user' ? { ...message, body: '' } : message,
        )
      }
      event('status_changed', { from: before, to: 'withdrawn' }, 'user')
      event('withdrawn', { deleteText: input.deleteText }, 'user')
      json(res, current())
      return
    }
    if (url.pathname === '/api/v1/updates') {
      json(res, { items: [] })
      return
    }
    res.writeHead(404)
    res.end('{}')
  }
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      res.writeHead(500)
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server has no TCP address.')
  const previous = HostApiContracts.getCommunityEndpoint.parseResponse(
    await (await request.get('/api/community/endpoint')).json(),
  )
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(error.message))
  const screenshots = path.resolve('.local/feedback-qa')
  await mkdir(screenshots, { recursive: true })
  try {
    expect(
      (
        await request.put('/api/community/endpoint', {
          data: { url: `http://127.0.0.1:${address.port}`, acknowledgeInsecure: false },
        })
      ).ok(),
    ).toBe(true)
    await request.delete('/api/community/login')
    const initialSettings = HostApiContracts.updateCommunityFeedbackSettings.parseResponse(
      await (
        await request.put('/api/community/feedback/settings', { data: { enabled: false, consent: false } })
      ).json(),
    )
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/settings/feedback')
    await expect(page.getByRole('heading', { name: '社区反馈', exact: true })).toBeVisible()
    await expect(page.getByRole('switch', { name: '启用社区反馈工具', exact: true })).toBeDisabled()
    const popupPromise = page.waitForEvent('popup')
    await page.getByRole('button', { name: '登录社区', exact: true }).click()
    const popup = await popupPromise
    await expect(popup.getByRole('heading', { name: '已登录社区', exact: true })).toBeVisible()
    await popup.close()
    await page.bringToFront()
    await expect(page.getByRole('switch', { name: '启用社区反馈工具', exact: true })).toBeEnabled({ timeout: 15_000 })
    await page.getByRole('switch', { name: '启用社区反馈工具', exact: true }).click()
    if (initialSettings.consentedAt === null)
      await page.getByRole('button', { name: '同意并开启', exact: true }).click()
    await expect(page.getByRole('switch', { name: '启用社区反馈工具', exact: true })).toBeChecked()
    await page.getByRole('link', { name: '查看反馈', exact: true }).click()
    await page.getByRole('button', { name: '新建反馈', exact: true }).click()
    await page.getByLabel('标题', { exact: true }).fill('列表刷新验收样例')
    await page
      .getByLabel('正文', { exact: true })
      .fill(`保存后列表没有更新。虚构路径 ${path.join('/', 'Users', 'fixture', 'sample.log')}。`)
    await page.getByRole('button', { name: '保存草稿', exact: true }).click()
    await expect(page).toHaveURL(/draft=fbd_/u)
    const attention = HostApiContracts.listAttention.parseResponse(await (await request.get('/api/attention')).json())
    expect(
      attention.items.some((entry) => entry.kind === 'community-feedback' && entry.title.includes('等待确认')),
    ).toBe(true)
    await page.getByRole('button', { name: '预览并发送', exact: true }).click()
    const confirm = page.getByRole('dialog', { name: '确认发送反馈', exact: true })
    await expect(confirm).toContainText('<本机路径>')
    await confirm.getByRole('button', { name: '查看将发送的完整内容', exact: true }).click()
    await expect(confirm.locator('pre')).toContainText('nxtVersion')
    await page.screenshot({ path: path.join(screenshots, 'nxt-preview.png'), animations: 'disabled' })
    await confirm.getByRole('button', { name: '发送反馈', exact: true }).click()
    await expect(page).toHaveURL(/ref=FB-1/u)
    await expect(page.getByRole('heading', { name: '列表刷新验收样例', exact: true })).toBeVisible()
    current().messages = [
      {
        id: 'fmsg_maintainer',
        authorKind: 'admin',
        author: 'sample-reviewer',
        audience: 'everyone',
        body: '已在当前版本修复，请更新后确认。',
        createdAt: Date.now(),
      },
    ]
    event('message', { messageId: 'fmsg_maintainer', audience: 'everyone' })
    const snapshot = HostApiContracts.snapshot.parseResponse(await (await request.get('/api/snapshot')).json())
    current().status = 'fixed'
    current().fixedIn = snapshot.productMetadata?.version ?? '0.5.0'
    current().closedAt = Date.now()
    event('status_changed', { from: 'new', to: 'fixed', fixedIn: current().fixedIn })
    await page.reload()
    await expect(page.getByText('已在当前版本修复，请更新后确认。', { exact: true })).toBeVisible()
    await expect(page.getByText('可以确认是否已解决。', { exact: true })).toBeVisible()
    for (const theme of ['浅色', '深色'] as const) {
      await page.goto('/settings/appearance')
      await page.getByText(theme, { exact: true }).click()
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        await page.goto('/community/feedback?ref=FB-1')
        await expect(page.getByRole('heading', { name: '列表刷新验收样例', exact: true })).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
        await page.screenshot({
          path: path.join(screenshots, `nxt-${theme === '浅色' ? 'light' : 'dark'}-${width}.png`),
          animations: 'disabled',
          fullPage: true,
        })
        if (width === 390) {
          await page.getByRole('textbox', { name: '追加说明', exact: true }).fill('窄屏追加的虚构说明。')
          await page.getByRole('button', { name: '发送说明', exact: true }).click()
          await expect(page.getByRole('textbox', { name: '追加说明', exact: true })).toHaveValue('')
          await page.getByRole('button', { name: '发送说明', exact: true }).scrollIntoViewIfNeeded()
          await page.screenshot({
            path: path.join(screenshots, `nxt-${theme === '浅色' ? 'light' : 'dark'}-390-reply.png`),
            animations: 'disabled',
          })
        }
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.getByRole('button', { name: '已解决', exact: true }).click()
    await expect(page.getByRole('button', { name: '已确认解决', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: '重新打开', exact: true }).click()
    const reopen = page.getByRole('dialog', { name: '重新打开反馈', exact: true })
    await reopen.getByLabel('原因', { exact: true }).fill('更新后仍能复现这个虚构样例。')
    await reopen.getByRole('button', { name: '重新打开', exact: true }).click()
    await expect(page.getByRole('button', { name: '撤回', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '撤回', exact: true }).click()
    const withdraw = page.getByRole('dialog', { name: '撤回这条反馈？', exact: true })
    await withdraw.getByRole('switch', { name: '同时删除标题、正文和我追加的说明', exact: true }).click()
    await withdraw.getByRole('button', { name: '撤回', exact: true }).click()
    await expect(page.getByRole('heading', { name: '已删除', exact: true })).toBeVisible()
    await page.goto('/settings/feedback')
    await page.getByRole('button', { name: '查看最近一次发送的内容', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '最近一次发送的内容' })).toContainText('还没有发送记录。')
    expect(failures).toEqual([])
  } finally {
    await request
      .put('/api/community/feedback/settings', { data: { enabled: false, consent: false } })
      .catch(() => undefined)
    await request.delete('/api/community/login').catch(() => undefined)
    await request
      .put('/api/community/endpoint', {
        data: { url: previous.url, acknowledgeInsecure: previous.insecure },
      })
      .catch(() => undefined)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
