import { HostApiContracts, ScheduledTaskIdSchema } from '@nekro-nxt/contracts'
import { writeContractJson, writeError, type HostRouteContext } from './host-route-support.js'
import { ScheduledTaskError } from './scheduled-tasks.js'

const STATUS: Record<ScheduledTaskError['code'], number> = {
  'not-found': 404,
  forbidden: 403,
  invalid: 400,
  limit: 409,
}

/** Administrator handling of scheduled tasks; creation and edits go through the agent in chat. */
export function registerScheduledTaskRoutes({ runtime, registerRoute, broadcast }: HostRouteContext): () => void {
  const admin = { kind: 'admin' } as const
  const unsubscribe = runtime.scheduledTasks.subscribe(() => {
    broadcast({ event: 'snapshot-changed', data: { changed: true } })
  })
  registerRoute({
    kind: 'prefix',
    path: '/api/scheduled-tasks',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const match = /^\/api\/scheduled-tasks\/([^/]+)(?:\/(pause|resume|run))?$/u.exec(url.pathname)
      if (match === null) {
        writeError(res, 404, 'not-found', `Unknown route: ${req.method} ${url.pathname}`)
        return
      }
      const action = match[2]
      try {
        const taskId = ScheduledTaskIdSchema.parse(decodeURIComponent(match[1] ?? ''))
        if (action === undefined) {
          if (req.method !== 'DELETE') throw new ScheduledTaskError('Method not allowed.', 'invalid')
          runtime.scheduledTasks.delete(admin, taskId)
          writeContractJson(res, 200, HostApiContracts.deleteScheduledTask, { deleted: true })
          return
        }
        if (req.method !== 'POST') throw new ScheduledTaskError('Method not allowed.', 'invalid')
        if (action === 'pause') {
          writeContractJson(res, 200, HostApiContracts.pauseScheduledTask, runtime.scheduledTasks.pause(admin, taskId))
        } else if (action === 'resume') {
          writeContractJson(
            res,
            200,
            HostApiContracts.resumeScheduledTask,
            runtime.scheduledTasks.resume(admin, taskId),
          )
        } else {
          writeContractJson(
            res,
            200,
            HostApiContracts.runScheduledTask,
            await runtime.scheduledTasks.run(admin, taskId),
          )
        }
      } catch (error) {
        const status = error instanceof ScheduledTaskError ? STATUS[error.code] : 400
        writeError(res, status, 'scheduled-task-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })
  return unsubscribe
}
