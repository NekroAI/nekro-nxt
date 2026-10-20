import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NekroRuntime } from '../src/bootstrap.js'
import { createNekroHostApi } from '../src/host-api.js'
import { configureDshLlmProviders } from '../src/main.js'
import { ModelProviderAccess, openModelOptions } from '../src/model-provider-access.js'
import type { SystemSettingRecord } from '@nekro-nxt/storage-sqlite'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

class MemorySettings {
  readonly records = new Map<string, SystemSettingRecord>()
  getSystemSetting(key: string) {
    return this.records.get(key)
  }
  putSystemSetting(key: string, value: SystemSettingRecord['value'], expected: number | undefined, at: number) {
    if (this.records.get(key)?.revision !== expected) throw new Error('revision conflict')
    const record = { key, value, revision: (expected ?? 0) + 1, updatedAt: at }
    this.records.set(key, record)
    return record
  }
}

describe('model provider access', () => {
  it('opens the providers present at first start and keeps later ones closed until opened', async () => {
    const settings = new MemorySettings()
    const access = new ModelProviderAccess(settings, () => 1)
    await access.prepare(() => Promise.resolve(['existing']))
    expect(access.isOpen('existing')).toBe(true)
    expect(access.isOpen('added-later')).toBe(false)

    // A second start reads the record instead of opening what is configured now.
    const restarted = new ModelProviderAccess(settings, () => 2)
    await restarted.prepare(() => Promise.resolve(['existing', 'added-later']))
    expect(restarted.isOpen('added-later')).toBe(false)
    restarted.set('added-later', true)
    restarted.set('existing', false)
    expect([restarted.isOpen('existing'), restarted.isOpen('added-later')]).toEqual([false, true])
  })

  it('offers extensions only the models of open providers that can answer', async () => {
    const catalog = {
      getLlmProviderSettings: () =>
        Promise.resolve({
          providers: [
            { provider: 'open', active: true },
            { provider: 'closed', active: true },
            { provider: 'unkeyed', active: true, credential: { configured: false } },
          ],
        }),
      listAvailableLlmModels: () =>
        Promise.resolve([
          { provider: 'open', providerName: '开放', id: 'chat', name: '对话' },
          { provider: 'closed', providerName: '关闭', id: 'chat', name: '对话' },
          { provider: 'unkeyed', providerName: '未配置', id: 'chat', name: '对话' },
        ]),
    }
    const options = await openModelOptions(catalog, { isOpen: (provider) => provider !== 'closed' })
    expect(options.map((option) => option.ref)).toEqual(['open:chat'])
  })
})

describe('credentials API', () => {
  it('manages credentials without returning values and asks before removing one in use', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-credentials-api-'))
    directories.push(directory)
    const runtime = await NekroRuntime.create({
      coreDatabasePath: path.join(directory, 'core.sqlite'),
      sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
      assetRoot: path.join(directory, 'assets'),
      extensionDataRoot: path.join(directory, 'extension-data'),
      extensionCacheRoot: path.join(directory, 'extension-cache'),
      llmSettingsPath: path.join(directory, 'dsh', 'settings.yaml'),
      llmCredentialPath: path.join(directory, 'dsh', '.credentials.yaml'),
      configureLlm: configureDshLlmProviders([]),
    })
    const webContext = new Context()
    await webContext.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const api = createNekroHostApi(webContext.webServer, runtime)
    const origin = `http://127.0.0.1:${api.port}/api/settings/credentials`
    const call = async (pathname: string, method: string, body?: unknown) => {
      const response = await fetch(`${origin}${pathname}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      })
      const text = await response.text()
      expect(text).not.toContain('fictional-weather-key')
      expect(text).not.toContain('credential:local')
      return { status: response.status, json: JSON.parse(text) as unknown }
    }
    try {
      const seeded = runtime.core.createAgentWithChannel(
        { displayName: '凭据智能体', persona: '', model: { provider: 'test-provider', model: 'chat-model' } },
        { connectionId: runtime.internalConnectionId, kind: 'internal', triggerPolicy: 'always' },
      )
      const agentId = seeded.definition.id
      const initial = HostApiContracts.getCredentials.parseResponse((await call('', 'GET')).json)
      expect(initial.credentials).toEqual([])
      // Providers configured at first start stay open to agents and extensions.
      expect(initial.modelProviders.length).toBeGreaterThan(0)
      expect(initial.modelProviders.every((provider) => provider.open)).toBe(true)

      const { request } = runtime.credentialRequests.create({
        agentId,
        channelId: seeded.channel.id,
        name: '天气服务',
        purpose: '查天气',
        domains: ['api.weather.test'],
        usage: 'request',
      })
      expect(HostApiContracts.getCredentials.parseResponse((await call('', 'GET')).json).requests).toEqual([request])
      const notify = vi.spyOn(runtime.host, 'notifyAgent')

      const created = HostApiContracts.createCredential.parseResponse(
        (
          await call('', 'POST', {
            kind: 'generic',
            name: '天气服务',
            description: '天气查询',
            domains: ['api.weather.test'],
            value: 'fictional-weather-key',
            agentScope: { agentIds: [agentId] },
          })
        ).json,
      )
      const [credential] = created.credentials
      expect(credential).toMatchObject({
        name: '天气服务',
        usage: 'request',
        redactable: true,
        available: true,
        usedBy: { extensions: [], commandAgents: [] },
        lastUsedAt: null,
      })
      // Saving the requested name answers the agent's request and wakes it in its channel.
      expect(created.requests).toEqual([])
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ agentId, channelId: seeded.channel.id }))

      const duplicate = await call('', 'POST', { kind: 'generic', name: '天气服务', value: 'another-fixture-value' })
      expect(duplicate.status).toBe(400)

      const updated = HostApiContracts.updateCredential.parseResponse(
        (await call(`/${credential!.id}`, 'PATCH', { usage: 'program', autoUse: false, envName: 'WEATHER_KEY' })).json,
      )
      expect(updated.credentials[0]).toMatchObject({
        usage: 'program',
        autoUse: false,
        envName: 'WEATHER_KEY',
        approvedAgentIds: [],
      })
      await call(`/${credential!.id}/value`, 'PUT', { value: 'fictional-weather-key-2' })
      expect(runtime.credentialLibrary.usable(credential!.id, agentId, 'program')).toMatchObject({
        value: 'fictional-weather-key-2',
      })

      // Automatic use is off, so the agent's commands receive it only once an administrator approves.
      runtime.core.reviseAgent(agentId, seeded.revision.id, {
        displayName: seeded.revision.displayName,
        persona: seeded.revision.persona,
        personaDocument: seeded.revision.personaDocument,
        model: seeded.revision.model,
        capabilities: { ...seeded.revision.capabilities, developmentShell: true },
        imagePolicy: seeded.revision.imagePolicy,
      })
      expect(
        HostApiContracts.getCredentials.parseResponse((await call('', 'GET')).json).credentials[0]?.usedBy,
      ).toEqual({ extensions: [], commandAgents: [] })
      await runtime.credentialLibrary.approve(credential!.id, agentId)
      runtime.credentialLibrary.recordUse({
        credentialId: credential!.id,
        agentId,
        consumerKind: 'command',
        consumerId: 'shell',
      })
      const uses = HostApiContracts.getCredentialUses.parseResponse((await call(`/${credential!.id}/uses`, 'GET')).json)
      expect(uses.uses).toMatchObject([{ agentId, consumerKind: 'command', consumerId: 'shell' }])
      const asked = HostApiContracts.removeCredential.parseResponse(
        (await call(`/${credential!.id}/remove`, 'POST', {})).json,
      )
      expect(asked).toEqual({ removed: false, usedBy: { extensions: [], commandAgents: [agentId] } })
      const removed = HostApiContracts.removeCredential.parseResponse(
        (await call(`/${credential!.id}/remove`, 'POST', { confirm: true })).json,
      )
      expect(removed).toMatchObject({ removed: true, view: { credentials: [] } })
      expect(runtime.credentialLibrary.usable(credential!.id, agentId, 'program')).toBeUndefined()

      const provider = initial.modelProviders[0]!.provider
      const closed = HostApiContracts.setModelProviderAccess.parseResponse(
        (await call(`/model-providers/${encodeURIComponent(provider)}`, 'PUT', { open: false })).json,
      )
      expect(closed.modelProviders.find((entry) => entry.provider === provider)?.open).toBe(false)
      expect((await call('/model-providers/no-such-provider', 'PUT', { open: true })).status).toBe(400)
    } finally {
      api.dispose()
      await webContext.fiber.dispose()
      await runtime.dispose()
    }
  })
})
