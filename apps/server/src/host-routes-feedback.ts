import { HostApiContracts } from '@nekro-nxt/contracts'
import { z } from 'zod'
import { CommunityError } from './community.js'
import { readJsonBody, writeContractJson, writeError, type HostRouteContext } from './host-route-support.js'

export function registerCommunityFeedbackRoutes({ runtime, registerRoute, broadcast }: HostRouteContext): () => void {
  const feedback = runtime.feedback
  const unsubscribe = feedback.subscribe(() => broadcast({ event: 'snapshot-changed', data: { changed: true } }))
  registerRoute({
    kind: 'prefix',
    path: '/api/community/feedback',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const suffix = url.pathname.slice('/api/community/feedback'.length)
      try {
        if (suffix === '/settings' && req.method === 'GET') {
          writeContractJson(res, 200, HostApiContracts.getCommunityFeedbackSettings, await feedback.getSettings())
          return
        }
        if (suffix === '/settings' && req.method === 'PUT') {
          const input = HostApiContracts.updateCommunityFeedbackSettings.parseRequest(await readJsonBody(req))
          writeContractJson(
            res,
            200,
            HostApiContracts.updateCommunityFeedbackSettings,
            await feedback.updateSettings(input.enabled, input.consent),
          )
          return
        }
        if (suffix === '' && req.method === 'GET') {
          const params = HostApiContracts.listCommunityFeedback.parseParams(Object.fromEntries(url.searchParams))
          writeContractJson(
            res,
            200,
            HostApiContracts.listCommunityFeedback,
            await feedback.list(params.refresh === '1'),
          )
          return
        }
        if (suffix === '/last-sent' && req.method === 'GET') {
          writeContractJson(res, 200, HostApiContracts.getLastSentCommunityFeedbackPayload, feedback.lastSent())
          return
        }
        if (suffix === '/drafts' && req.method === 'POST') {
          const input = HostApiContracts.createCommunityFeedbackDraft.parseRequest(await readJsonBody(req))
          writeContractJson(res, 200, HostApiContracts.createCommunityFeedbackDraft, await feedback.createDraft(input))
          return
        }
        const draft = /^\/drafts\/([^/]+)(?:\/(send|preview))?$/u.exec(suffix)
        if (draft) {
          const { draftId } = HostApiContracts.updateCommunityFeedbackDraft.parseParams({
            draftId: decodeURIComponent(draft[1]!),
          })
          if (draft[2] === 'preview' && req.method === 'GET') {
            writeContractJson(
              res,
              200,
              HostApiContracts.previewCommunityFeedbackPayload,
              feedback.previewDraft(draftId),
            )
            return
          }
          if (draft[2] === 'send' && req.method === 'POST') {
            const input = HostApiContracts.sendCommunityFeedbackDraft.parseRequest(await readJsonBody(req))
            writeContractJson(
              res,
              200,
              HostApiContracts.sendCommunityFeedbackDraft,
              await feedback.sendDraft(draftId, input),
            )
            return
          }
          if (draft[2] === undefined && req.method === 'PUT') {
            const input = HostApiContracts.updateCommunityFeedbackDraft.parseRequest(await readJsonBody(req))
            writeContractJson(
              res,
              200,
              HostApiContracts.updateCommunityFeedbackDraft,
              feedback.updateDraft(draftId, input),
            )
            return
          }
          if (draft[2] === undefined && req.method === 'DELETE') {
            writeContractJson(res, 200, HostApiContracts.discardCommunityFeedbackDraft, feedback.discardDraft(draftId))
            return
          }
        }
        const item = /^\/items\/([^/]+)(?:\/(messages|withdraw|reopen|confirm-fixed|affected))?$/u.exec(suffix)
        if (item) {
          const { ref } = HostApiContracts.getCommunityFeedback.parseParams({ ref: decodeURIComponent(item[1]!) })
          if (item[2] === undefined && req.method === 'GET') {
            writeContractJson(res, 200, HostApiContracts.getCommunityFeedback, await feedback.detail(ref))
            return
          }
          const actions = [
            ['messages', HostApiContracts.replyCommunityFeedback],
            ['withdraw', HostApiContracts.withdrawCommunityFeedback],
            ['reopen', HostApiContracts.reopenCommunityFeedback],
            ['confirm-fixed', HostApiContracts.confirmCommunityFeedbackFixed],
            ['affected', HostApiContracts.markCommunityFeedbackAffected],
          ] as const
          const action = actions.find(([name]) => name === item[2])
          if (action && req.method === 'POST') {
            const input = action[1].parseRequest(await readJsonBody(req))
            writeContractJson(res, 200, action[1], await feedback.act(ref, action[0], input))
            return
          }
        }
        writeError(res, 404, 'not-found', `Unknown route: ${req.method} ${url.pathname}`)
      } catch (error) {
        writeError(
          res,
          error instanceof CommunityError ? error.status : 400,
          error instanceof CommunityError ? error.code : 'community-feedback-failed',
          error instanceof z.ZodError
            ? '反馈内容格式不正确，请检查后重试。'
            : error instanceof Error
              ? error.message
              : '反馈操作失败，请重试。',
        )
      }
    },
  })
  return unsubscribe
}
