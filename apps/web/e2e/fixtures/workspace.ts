import type { Page, Route } from '@playwright/test'
import type { HostApiResponse } from '@nekro-nxt/contracts'

type Snapshot = HostApiResponse<'snapshot'>

/**
 * Answers the workspace read models the redesigned client asks for on every space (attention, activity, read
 * cursors, pending context, agent revisions) from a synthetic snapshot. Register it before narrower routes so a
 * test can still override one endpoint.
 */
export async function installWorkspaceRoutes(page: Page, snapshot: () => Snapshot): Promise<void> {
  const json = (route: Route, value: unknown) => route.fulfill({ json: value })
  await page.route('**/api/attention', (route) => json(route, { revision: 'fixture', items: [] }))
  await page.route('**/api/attention/*/dismiss', (route) => json(route, { dismissed: true, revision: 'fixture' }))
  await page.route('**/api/activity?*', (route) => {
    const now = Date.now()
    return json(route, {
      from: now - 2 * 60 * 60 * 1000,
      to: now,
      bucketMs: 5 * 60 * 1000,
      channels: [],
    })
  })
  await page.route('**/api/channels/*/read', (route) => {
    const channelId = new URL(route.request().url()).pathname.split('/')[3]
    return json(route, { channelId, activity: { unreadCount: 0, unreadCapped: false } })
  })
  // No channel prompt unless a test registers its own route after this one.
  await page.route('**/api/channels/*/prompt', (route) =>
    json(route, {
      instructions: {
        document: { version: 1, segments: [] },
        locked: false,
        revision: 0,
        maxChars: 4000,
        revisions: [],
      },
      notes: { document: { version: 1, segments: [] }, locked: false, revision: 0, maxChars: 2000, revisions: [] },
    }),
  )
  const contextPolicy = { backlogTextChars: 40_000, backlogImages: 6, idleReviewMinutes: 45 }
  await page.route('**/api/channels/*/member-notes', (route) => json(route, { notes: [], maxChars: 300 }))
  await page.route('**/api/product/updates', (route) =>
    json(route, { channel: 'development', currentVersion: 'fixture', state: 'unsupported', autoCheck: true }),
  )
  await page.route('**/api/channels/*/context-policy', (route) =>
    json(route, { policy: contextPolicy, defaults: contextPolicy, custom: false }),
  )
  await page.route('**/api/channels/*/pending', (route) => {
    const channelId = new URL(route.request().url()).pathname.split('/')[3]
    return json(route, { channelId, items: [] })
  })
  await page.route('**/api/agents/*/revisions', (route) => {
    const agentId = new URL(route.request().url()).pathname.split('/')[3]
    const agent = snapshot().agents.find((candidate) => candidate.id === agentId)
    if (!agent) return route.fulfill({ status: 404, json: { error: { code: 'not-found', message: '智能体不存在。' } } })
    return json(route, {
      agentId,
      currentRevisionId: agent.currentRevisionId,
      revisions: [
        {
          id: agent.currentRevisionId,
          revision: 1,
          createdAt: agent.createdAt,
          displayName: agent.displayName,
          model: { provider: agent.model.provider, model: agent.model.model },
          changedFields: [],
          current: true,
        },
      ],
    })
  })
}
