import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { writeUpgradeJson } from './upgrade-backup.js'
import { sessionEvents } from './session-event-history.js'

const schema = z
  .object({
    format: z.literal('nxt.session-shutdown-inbox'),
    version: z.literal(1),
    sessionId: z.string(),
    nextStep: z.array(z.unknown()),
    nextTurn: z.array(z.unknown()),
  })
  .strict()
const messageEnvelopeSchema = z
  .object({
    role: z.literal('user'),
    id: z.string().min(1),
    content: z.array(z.unknown()),
    source: z.object({ kind: z.string() }).passthrough(),
  })
  .passthrough()
const messageSchema = z.custom<UserMessage>(
  (value) => messageEnvelopeSchema.safeParse(value).success,
  'Invalid shutdown inbox message.',
)
const filename = (root: string, id: string) => path.join(root, `${createHash('sha256').update(id).digest('hex')}.json`)

/** A shutdown transaction journal: the upstream handle's dispose durably clears its inbox. */
export async function checkpointShutdownInbox(root: string, agent: Agent): Promise<void> {
  if (agent.inbox.nextStep.length === 0 && agent.inbox.nextTurn.length === 0) return
  await writeUpgradeJson(filename(root, agent.id), {
    format: 'nxt.session-shutdown-inbox',
    version: 1,
    sessionId: agent.id,
    nextStep: agent.inbox.nextStep,
    nextTurn: agent.inbox.nextTurn,
  })
}

const parseUserMessage = (value: unknown): UserMessage => {
  const parsed = messageSchema.parse(value)
  // The public constructor validates JSON and immutable message semantics after the envelope check.
  return freezeMessage(parsed)
}

/** Reapply only unconsumed identities during awaited agent/created, before its driver is released. */
export async function restoreShutdownInbox(root: string, context: Context, agent: Agent): Promise<void> {
  let source: string
  try {
    source = await readFile(filename(root, agent.id), 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
  const checkpoint = schema.parse(JSON.parse(source))
  if (checkpoint.sessionId !== agent.id) throw new Error('Session shutdown checkpoint identity mismatch.')
  const batches = [
    ['next-step', checkpoint.nextStep.map(parseUserMessage)],
    ['next-turn', checkpoint.nextTurn.map(parseUserMessage)],
  ] as const
  const known = new Set([
    ...sessionEvents(agent.session).flatMap((event) => (event.type === 'user/message' ? [String(event.data.id)] : [])),
    ...agent.inbox.nextStep.map(({ id }) => String(id)),
    ...agent.inbox.nextTurn.map(({ id }) => String(id)),
  ])
  for (const [target, messages] of batches) {
    for (const message of messages) {
      if (known.has(message.id)) continue
      agent.inbox.append(target, message)
      known.add(message.id)
    }
  }
  await context.sessions.flush(agent.session)
  await rm(filename(root, agent.id))
}
