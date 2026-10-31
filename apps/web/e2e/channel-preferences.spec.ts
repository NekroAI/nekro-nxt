import { HostApiContracts } from '@nekro-nxt/contracts'
import { expect, test } from '@playwright/test'
import { createOneBotProtocolFixture } from '../../../packages/adapter-onebot-11/tests/protocol-fixture.js'

test('platform updates preserve local names and rebinding preserves the processing feedback choice', async ({
  page,
  request,
}, testInfo) => {
  const protocol = await createOneBotProtocolFixture()
  let createdConnectionId: string | undefined
  const createdAgents: string[] = []
  let providerConfigured = false
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(error.message))
  try {
    const created = await request.post('/api/connections', {
      data: { adapterKey: 'onebot-11', configuration: { endpoint: protocol.endpoint }, credentials: {} },
    })
    expect(created.ok()).toBe(true)
    const { connectionId } = HostApiContracts.createConnection.response.parse(await created.json())
    createdConnectionId = connectionId
    const snapshot = async () =>
      HostApiContracts.snapshot.parseResponse(await (await request.get('/api/snapshot')).json())
    await expect
      .poll(
        async () => (await snapshot()).connections.find((connection) => connection.id === connectionId)?.status.state,
      )
      .toBe('connected')
    const group = `synthetic-group-${Date.now()}`
    protocol.emit(group, '平台初始名称')
    await expect
      .poll(
        async () => (await snapshot()).channels.find((channel) => channel.connectionId === connectionId)?.displayName,
      )
      .toBe('平台初始名称')
    const channel = (await snapshot()).channels.find((candidate) => candidate.connectionId === connectionId)!
    await page.goto(`/channels/${channel.id}`)
    await page.getByRole('button', { name: '修改频道名称' }).click()
    await page.getByRole('textbox', { name: '频道名称', exact: true }).fill('我的频道备注')
    await page.getByRole('textbox', { name: '频道名称', exact: true }).press('Enter')
    await expect
      .poll(async () => (await snapshot()).channels.find((candidate) => candidate.id === channel.id)?.displayName)
      .toBe('我的频道备注')
    protocol.emit(group, '平台更新名称')
    await expect(page.getByText(/^平台名称：平台更新名称/u)).toBeVisible()
    await expect(page.getByRole('button', { name: '修改频道名称' })).toContainText('我的频道备注')
    await page.screenshot({ path: testInfo.outputPath('local-name-preserved.png'), animations: 'disabled' })
    await page.getByRole('button', { name: '改用平台名称', exact: true }).click()
    await expect(page.getByRole('button', { name: '修改频道名称' })).toContainText('平台更新名称')
    protocol.emit(group, '平台再次更新')
    await expect(page.getByRole('button', { name: '修改频道名称' })).toContainText('平台再次更新')
    // A configured synthetic catalog is enough for binding; observe-only never calls the fake model endpoint.
    const providers = HostApiContracts.llmProviders.parseResponse(
      await (await request.get('/api/llm/providers')).json(),
    )
    // Providers share one settings namespace; an unrelated first entry may carry another namespace's revision.
    const provider =
      providers.providers.find((item) => item.provider === 'synthetic-fixture') ??
      providers.providers.find((item) => item.settingsNs === 'llm-pi-ai')
    const saved = await request.post('/api/llm/providers/synthetic-fixture', {
      data: {
        expectedRevision: provider?.settingsRevision ?? 0,
        apiKey: 'synthetic-fixture-key',
        displayName: '虚构模型供应商',
        baseURL: 'https://models.example.test/v1',
        api: 'openai-completions',
        models: [{ id: 'unavailable-test-model', name: '虚构模型', contextWindow: 64_000, maxTokens: 8000 }],
      },
    })
    expect(saved.ok()).toBe(true)
    providerConfigured = true
    const agents = []
    for (const displayName of ['虚构验收智能体甲', '虚构验收智能体乙']) {
      const response = await request.post('/api/agents', {
        data: { displayName, persona: '', model: { provider: 'synthetic-fixture', model: 'unavailable-test-model' } },
      })
      expect(response.ok()).toBe(true)
      agents.push(HostApiContracts.createAgent.response.parse(await response.json()).agentId)
      createdAgents.push(agents[agents.length - 1]!)
    }
    for (const [index, agentId] of agents.entries()) {
      const response = await request.post('/api/bindings', {
        data: {
          channelId: channel.id,
          agentId,
          triggerPolicy: 'observe-only',
          ...(index === 0 ? { processingFeedback: 'off' } : {}),
        },
      })
      expect(response.ok()).toBe(true)
      expect(HostApiContracts.createBinding.response.parse(await response.json()).processingFeedback).toBe('off')
    }
    await page.reload()
    await expect(page.getByRole('switch', { name: '处理中反馈' })).not.toBeChecked()
    await page.screenshot({ path: testInfo.outputPath('rebound-feedback-off.png'), animations: 'disabled' })
    await page.route('**/api/snapshot', async (route) => {
      const response = await route.fetch()
      const body = HostApiContracts.snapshot.parseResponse(await response.json())
      await route.fulfill({
        json: {
          ...body,
          capabilityAvailability: {
            ...body.capabilityAvailability,
            webSearch: {
              ...body.capabilityAvailability.webSearch,
              available: false,
              unavailableReason: '检索状态暂时不可用，请稍后重试。',
            },
          },
        },
      })
    })
    await page.goto(`/agents/${agents[0]}`)
    await page.getByRole('button', { name: '能力', exact: true }).click()
    await expect(page.getByText('检索状态暂时不可用，请稍后重试。', { exact: true })).toBeVisible()
    await expect(page.getByText('搜索凭据', { exact: true })).toHaveCount(0)
    await page.getByText('检索状态暂时不可用，请稍后重试。', { exact: true }).scrollIntoViewIfNeeded()
    await expect(page.getByText('检索状态暂时不可用，请稍后重试。', { exact: true })).toBeInViewport()
    await page.screenshot({ path: testInfo.outputPath('auxiliary-error-local.png'), animations: 'disabled' })
    expect(failures).toEqual([])
  } finally {
    await page.unrouteAll({ behavior: 'wait' })
    await page.goto('about:blank')
    const current = HostApiContracts.snapshot.parseResponse(await (await request.get('/api/snapshot')).json())
    for (const id of createdAgents) {
      const agent = current.agents.find((item) => item.id === id)
      if (agent)
        expect(
          (
            await request.delete(`/api/agents/${id}`, {
              data: {
                expectedCurrentRevisionId: agent.currentRevisionId,
                confirmationName: agent.displayName,
                deleteAutoCreatedBuiltInChannels: true,
                deleteWorkspace: true,
              },
            })
          ).ok(),
        ).toBe(true)
    }
    if (createdConnectionId)
      expect(
        (await request.delete(`/api/connections/${createdConnectionId}`, { data: { deleteChannelData: true } })).ok(),
      ).toBe(true)
    if (providerConfigured) {
      const impact = HostApiContracts.llmProviderRemovalImpact.parseResponse(
        await (await request.get('/api/llm/providers/synthetic-fixture/removal-impact')).json(),
      )
      expect(
        (
          await request.delete('/api/llm/providers/synthetic-fixture', {
            data: { expectedRevision: impact.expectedRevision },
          })
        ).ok(),
      ).toBe(true)
    }
    await protocol.stop()
  }
})
