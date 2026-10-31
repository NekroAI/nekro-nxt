import { HostApiContracts } from '@nekro-nxt/contracts'
import { expect, test } from '@playwright/test'
import { createOneBotProtocolFixture } from '../../../packages/adapter-onebot-11/tests/protocol-fixture.js'

test('smart response settings save per channel and agent aliases save with the persona', async ({
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
    protocol.emit(`synthetic-group-${Date.now()}`, '虚构闲聊群')
    await expect
      .poll(async () => (await snapshot()).channels.some((channel) => channel.connectionId === connectionId))
      .toBe(true)
    const channel = (await snapshot()).channels.find((candidate) => candidate.connectionId === connectionId)!
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
    expect(saved.ok(), await saved.text()).toBe(true)
    providerConfigured = true
    const agentResponse = await request.post('/api/agents', {
      data: {
        displayName: '虚构看板娘',
        persona: '',
        model: { provider: 'synthetic-fixture', model: 'unavailable-test-model' },
      },
    })
    expect(agentResponse.ok()).toBe(true)
    const agentId = HostApiContracts.createAgent.response.parse(await agentResponse.json()).agentId
    createdAgents.push(agentId)
    const bound = await request.post('/api/bindings', {
      data: { channelId: channel.id, agentId, triggerPolicy: 'smart' },
    })
    expect(bound.ok()).toBe(true)
    const timing = async () =>
      (await snapshot()).channels.find((candidate) => candidate.id === channel.id)?.bindings[0]?.responseTiming

    await page.goto(`/channels/${channel.id}`)
    await expect(page.getByRole('switch', { name: '提到名字时' })).toBeChecked()
    await expect(page.getByRole('switch', { name: '等对方说完' })).toBeChecked()
    await page.getByRole('spinbutton', { name: '合并连发（秒）' }).fill('5')
    await page.getByRole('spinbutton', { name: '合并连发（秒）' }).press('Enter')
    await expect.poll(timing).toEqual({ debounceSeconds: 5 })
    // Out-of-range input snaps to the bound instead of being rejected.
    await page.getByRole('spinbutton', { name: '每次最多等（秒）' }).fill('9999')
    await page.getByRole('spinbutton', { name: '每次最多等（秒）' }).press('Enter')
    await expect.poll(timing).toEqual({ debounceSeconds: 5, waitMaxQuietSeconds: 300 })
    await page.getByRole('switch', { name: '接着说时' }).click()
    await expect.poll(async () => (await timing())?.attentionWake).toBe(false)
    await expect(page.getByRole('spinbutton', { name: '聊过后持续（秒）' })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('smart-timing.png'), animations: 'disabled', fullPage: true })
    await page.getByRole('button', { name: '恢复默认' }).click()
    await expect.poll(timing).toEqual({})

    // Another rule keeps the timing; waiting stays, the smart-only rows go away.
    await request.post('/api/bindings', {
      data: {
        channelId: channel.id,
        agentId,
        triggerPolicy: 'mentioned-or-replied',
        responseTiming: { waitEnabled: false },
      },
    })
    await page.reload()
    await expect(page.getByRole('switch', { name: '等对方说完' })).not.toBeChecked()
    await expect(page.getByRole('switch', { name: '提到名字时' })).toHaveCount(0)

    await page.goto(`/agents/${agentId}`)
    await page.getByRole('textbox', { name: '别名', exact: true }).fill('小板、 板娘，小板')
    await page.getByRole('region', { name: '未保存的修改' }).getByRole('button', { name: '保存' }).click()
    await expect
      .poll(async () => (await snapshot()).agents.find((agent) => agent.id === agentId)?.aliases)
      .toEqual(['小板', '板娘'])
    await page.reload()
    await expect(page.getByRole('textbox', { name: '别名', exact: true })).toHaveValue('小板、板娘')
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
