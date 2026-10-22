import { ChannelIdSchema, HostApiContracts, SubConversationIdSchema, type SubConversation } from '@nekro-nxt/contracts'
import type { SubConversationRecord } from '@nekro-nxt/storage-sqlite'
import { projectChannelRuntime } from './channel-runtime-projection.js'
import { readJsonBody, writeContractJson, writeError, type HostRouteContext } from './host-route-support.js'
import type { MessagePacingSettingsStore } from './message-pacing.js'
import { readSubConversationRetention, writeSubConversationRetention } from './sub-conversation-settings.js'
import { SubConversationError } from './sub-conversations.js'
import type { NekroRuntime } from './bootstrap.js'

/** What the API shows of a sub-conversation; session ids stay inside the host. */
export const projectSubConversation = (record: SubConversationRecord): SubConversation => ({
  id: record.id,
  channelId: record.channelId,
  episodeId: record.episodeId,
  agentId: record.agentId,
  title: record.title,
  openedBy: record.openedBy,
  driver: record.driver,
  status: record.status,
  ...(record.closeReason === undefined ? {} : { closeReason: record.closeReason }),
  ...(record.summary === undefined ? {} : { summary: record.summary }),
  ...(record.authoringTaskId === undefined ? {} : { authoringTaskId: record.authoringTaskId }),
  ...(record.model === undefined ? {} : { model: record.model }),
  createdAt: record.createdAt,
  ...(record.closedAt === undefined ? {} : { closedAt: record.closedAt }),
})

/** How many ended sub-conversations of each channel the snapshot carries; the channel page lists the rest. */
const SNAPSHOT_CLOSED_PER_CHANNEL = 10

/** Open sub-conversations, and the most recent ended ones of each channel, for the snapshot. */
export const snapshotSubConversations = (runtime: NekroRuntime): SubConversation[] => {
  const closedPerChannel = new Map<string, number>()
  return runtime.repository.listSubConversations({}).flatMap((record) => {
    if (record.status === 'open') return [projectSubConversation(record)]
    const count = closedPerChannel.get(record.channelId) ?? 0
    if (count >= SNAPSHOT_CLOSED_PER_CHANNEL) return []
    closedPerChannel.set(record.channelId, count + 1)
    return [projectSubConversation(record)]
  })
}

const settingsStore = (runtime: NekroRuntime): MessagePacingSettingsStore => ({
  get: (key) => runtime.repository.getSystemSetting(key),
  put: (key, value, expectedRevision) => {
    runtime.repository.putSystemSetting(key, value, expectedRevision, Date.now())
  },
})

export function registerSubConversationRoutes({ runtime, registerRoute, broadcast }: HostRouteContext): () => void {
  const unsubscribe = runtime.subscribeSubConversations(() =>
    broadcast({ event: 'snapshot-changed', data: { changed: true } }),
  )
  const reject = (res: Parameters<typeof writeError>[0], error: unknown) =>
    writeError(
      res,
      error instanceof SubConversationError ? 400 : 500,
      'sub-conversation-failed',
      error instanceof Error ? error.message : String(error),
    )

  registerRoute({
    kind: 'exact',
    path: '/api/settings/sub-conversations',
    handler: async (req, res) => {
      if (req.method === 'GET') {
        writeContractJson(res, 200, HostApiContracts.getSubConversationSettings, {
          retention: readSubConversationRetention(settingsStore(runtime)),
        })
        return
      }
      if (req.method !== 'PUT') {
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
        return
      }
      const parsed = HostApiContracts.updateSubConversationSettings.parseRequest(await readJsonBody(req))
      writeContractJson(res, 200, HostApiContracts.updateSubConversationSettings, {
        retention: writeSubConversationRetention(settingsStore(runtime), parsed.retention),
      })
      void runtime.host.subConversations.sweep().catch((error: unknown) => {
        console.error('[nekro-nxt] 清理已结束的子对话失败：', error)
      })
    },
  })

  registerRoute({
    kind: 'prefix',
    path: '/api/sub-conversations',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      try {
        const channel = /^\/api\/sub-conversations\/channels\/([^/]+)$/u.exec(url.pathname)
        if (channel !== null && req.method === 'GET') {
          const channelId = ChannelIdSchema.parse(decodeURIComponent(channel[1] ?? ''))
          writeContractJson(res, 200, HostApiContracts.listSubConversations, {
            items: runtime.repository.listSubConversations({ channelId }).map(projectSubConversation),
          })
          return
        }
        const match = /^\/api\/sub-conversations\/([^/]+)(?:\/(runtime|close))?$/u.exec(url.pathname)
        const parsedId = SubConversationIdSchema.safeParse(decodeURIComponent(match?.[1] ?? ''))
        if (match === null || !parsedId.success) {
          writeError(res, 404, 'not-found', `Unknown route: ${req.method} ${url.pathname}`)
          return
        }
        const id = parsedId.data
        const action = match[2]
        if (action === 'runtime' && req.method === 'GET') {
          const record = runtime.repository.getSubConversation(id)
          if (!record) {
            writeError(res, 404, 'not-found', '没有找到这个子对话。')
            return
          }
          const read = await runtime.host.subConversationEvents(record.dshSessionId)
          writeContractJson(res, 200, HostApiContracts.getSubConversationRuntime, {
            conversation: projectSubConversation(record),
            runtime: projectChannelRuntime({
              channelId: record.channelId,
              agentId: record.agentId,
              episodeId: record.episodeId,
              sessionStatus:
                read?.live === true
                  ? (runtime.host.tryLiveSession(record.dshSessionId)?.status ?? 'missing')
                  : 'missing',
              pendingInjectCount: 0,
              events: read?.events ?? [],
            }),
          })
          return
        }
        if (action === 'close' && req.method === 'POST') {
          HostApiContracts.closeSubConversation.parseRequest(await readJsonBody(req))
          writeContractJson(
            res,
            200,
            HostApiContracts.closeSubConversation,
            projectSubConversation(await runtime.host.subConversations.closeByAdmin(id)),
          )
          return
        }
        if (action === undefined && req.method === 'DELETE') {
          await runtime.host.subConversations.delete(id, 'admin')
          writeContractJson(res, 200, HostApiContracts.deleteSubConversation, { deleted: true })
          return
        }
        writeError(res, 405, 'method-not-allowed', 'Method not allowed.')
      } catch (error) {
        reject(res, error)
      }
    },
  })
  return unsubscribe
}
