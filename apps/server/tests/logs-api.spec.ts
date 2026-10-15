import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { hostLogPageSchema } from '@nekro-nxt/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { HostLogService } from '../src/logs/service.js'
import { registerLogRoutes } from '../src/host-routes-logs.js'
import { attachCordisLogs, bindLogOwner } from '../src/logs/bridge.js'
import { extensionLogger } from '../src/extension-logger.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})
const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nxt-log-api-'))
  const logs = await HostLogService.open({ dataRoot: root })
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  cleanup.push(() => logs.close())
  let route: WebRoute | undefined
  const stop = registerLogRoutes((registered) => {
    route = registered
  }, logs)
  const server = createServer((req, res) => {
    void route?.handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('No test port.')
  cleanup.push(async () => {
    stop()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  })
  return { logs, base: `http://127.0.0.1:${address.port}`, server }
}
const source = { kind: 'extension' as const, id: 'ext_synthetic', name: '虚构扩展' }
describe('log HTTP and SDK boundaries', () => {
  it('queries exact filters, exports unloaded records, rejects invalid input and does not delete history', async () => {
    const { logs, base } = await fixture()
    for (let i = 0; i < 510; i++)
      logs.write({ level: 'info', source, message: `虚构任务 ${i}`, scope: { agentId: 'agent_demo' } })
    await logs.flush()
    const response = await fetch(
      `${base}/api/logs?query=${encodeURIComponent(JSON.stringify({ limit: 2, keyword: '虚构任务', scope: { agentId: 'agent_demo' } }))}`,
    )
    const page = hostLogPageSchema.parse(await response.json())
    expect(page.entries).toHaveLength(2)
    expect(page.hasMore).toBe(true)
    const exported = await fetch(
      `${base}/api/logs/export?format=jsonl&query=${encodeURIComponent(JSON.stringify({ limit: 2, keyword: '虚构任务' }))}`,
    )
    expect(exported.headers.get('content-disposition')).toContain('.jsonl')
    expect((await exported.text()).trim().split('\n')).toHaveLength(510)
    expect((await fetch(`${base}/api/logs`, { method: 'DELETE' })).status).toBe(405)
    expect((await fetch(`${base}/api/logs?query=%7Bbad`)).status).toBe(400)
    expect((await fetch(`${base}/api/logs/missing`)).status).toBe(400)
    expect((await logs.status()).count).toBe(510)
  })
  it('replays more than a page before live records and closes streams on dispose', async () => {
    const { logs, base } = await fixture()
    const start = (await logs.status()).headCursor
    for (let i = 0; i < 610; i++) logs.write({ level: 'info', source, message: `虚构回放 ${i}` })
    await logs.flush()
    const abort = new AbortController()
    cleanup.push(() => {
      abort.abort()
      return Promise.resolve()
    })
    const response = await fetch(
      `${base}/api/logs/events?query=${encodeURIComponent(JSON.stringify({ afterCursor: start }))}`,
      { signal: abort.signal },
    )
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader()
    let text = ''
    const decoder = new TextDecoder()
    while (!text.includes('虚构回放 609')) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
    expect(text.match(/虚构回放 /gu)).toHaveLength(610)
    logs.write({ level: 'error', source, message: '虚构实时错误' })
    await logs.flush()
    while (!text.includes('虚构实时错误')) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
    expect(text).toContain('虚构实时错误')
    abort.abort()
  }, 20_000)
  it('uses revisions for settings and validates temporary debug duration', async () => {
    const { base } = await fixture()
    const save = (revision: number) =>
      fetch(`${base}/api/logs/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ retentionDays: 3, maxSizeMiB: 128, revision }),
      })
    expect((await save(0)).status).toBe(200)
    expect((await save(0)).status).toBe(409)
    expect(
      (
        await fetch(`${base}/api/logs/debug`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ durationMinutes: 1000 }),
        })
      ).status,
    ).toBe(400)
  })
  it('binds SDK scope, gates SDK 9 and keeps diagnostic arguments as details', async () => {
    const { logs } = await fixture()
    const logger = extensionLogger(logs, source, { agentId: 'agent_demo', extensionId: source.id }, 9)
    logger.info('虚构索引完成', { count: 12, token: 'fictional-secret' })
    expect(() => extensionLogger(logs, source, {}, 8).info('unsupported')).toThrow('requires.sdk')
    await logs.flush()
    const entry = (await logs.query()).entries[0]!
    expect(entry.scope?.extensionId).toBe(source.id)
    expect(JSON.stringify(entry)).not.toContain('fictional-secret')
  })
  it('captures Warn with the default threshold and public fiber ownership, without leaking parameters', async () => {
    const { logs } = await fixture()
    const context = new Context()
    attachCordisLogs(context, logs)
    bindLogOwner(context, logs, source, { agentId: 'agent_demo' })
    context.logger.warn('请求失败：%s', 'Bearer synthetic-private')
    await logs.flush()
    const entry = (await logs.query()).entries[0]!
    expect(entry.level).toBe('warn')
    expect(entry.source.id).toBe(source.id)
    expect(entry.message).not.toContain('%s')
    expect(JSON.stringify(entry)).not.toContain('synthetic-private')
    await context.fiber.dispose()
  })
})
