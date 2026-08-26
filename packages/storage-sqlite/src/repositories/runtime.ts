import { and, asc, desc, eq, gt, gte, inArray, notExists, or, sql } from 'drizzle-orm'
import type { AdapterRuntimeStateStore } from '@nekro-nxt/adapter-sdk'
import type { ChannelEventRecord } from '@nekro-nxt/core'
import type {
  AdmissionId,
  AgentId,
  AgentRevisionId,
  ChannelEventId,
  ChannelId,
  EpisodeId,
  JsonValue,
} from '@nekro-nxt/contracts'
import type {
  AdmissionRecord,
  EpisodeCloseReason,
  EpisodeHandoffRecord,
  EpisodeRecord,
  RuntimeRepository,
} from '@nekro-nxt/channel-runtime'
import type { DrizzleCoreDatabase } from '../database.js'
import {
  admissionEvents,
  admissions,
  channelEvents,
  connectionState,
  episodeHandoffEvents,
  episodeHandoffs,
  episodes,
} from '../schema.js'
import {
  AdmissionRowSchema,
  ChannelEventRowSchema,
  ConnectionStateRowSchema,
  EpisodeHandoffEventRowSchema,
  EpisodeHandoffRowSchema,
  EpisodeRowSchema,
} from '../row-schemas.js'

type RuntimeSlice = Pick<
  RuntimeRepository,
  | 'getEpisode'
  | 'getActiveEpisode'
  | 'listRecoverableEpisodes'
  | 'listActiveEpisodesForAgent'
  | 'getEpisodeHandoffTo'
  | 'createEpisode'
  | 'activateEpisode'
  | 'updateEpisodeRevision'
  | 'closeEpisode'
  | 'commitEpisodeRollover'
  | 'failEpisode'
  | 'createAdmission'
  | 'listRecoverableAdmissions'
  | 'listAdmittedEvents'
  | 'listUnadmittedEvents'
  | 'claimAdmission'
  | 'completeAdmission'
>

export interface DshSessionStorageRetirementReport {
  readonly episodesClosed: number
  readonly admissionsReleased: number
}

export interface DshSessionStorageMaintenance {
  retireDshSessionEpisodes(closedAt: number): DshSessionStorageRetirementReport
}

const toEpisode = (input: typeof episodes.$inferSelect): EpisodeRecord => {
  const row = EpisodeRowSchema.parse(input)
  return {
    id: row.id,
    channelId: row.channelId,
    agentId: row.agentId,
    agentRevisionId: row.agentRevisionId,
    ...(row.dshSessionId === null ? {} : { dshSessionId: row.dshSessionId }),
    status: row.status,
    openedAtEventId: row.openedAtEventId,
    ...(row.lastAdmittedEventId === null ? {} : { lastAdmittedEventId: row.lastAdmittedEventId }),
    ...(row.closedAtEventId === null ? {} : { closedAtEventId: row.closedAtEventId }),
    ...(row.closedAt === null ? {} : { closedAt: row.closedAt }),
    ...(row.closeReason === null ? {} : { closeReason: row.closeReason }),
    createdAt: row.createdAt,
  }
}

const toChannelEvent = (input: typeof channelEvents.$inferSelect): ChannelEventRecord => {
  const row = ChannelEventRowSchema.parse(input)
  return {
    id: row.id,
    logicalMessageId: row.logicalMessageId,
    channelId: row.channelId,
    ...(row.platformMessageId === null ? {} : { platformMessageId: row.platformMessageId }),
    kind: row.kind,
    ...(row.activityType === null ? {} : { activityType: row.activityType }),
    ...(row.targetPlatformMessageId === null ? {} : { targetPlatformMessageId: row.targetPlatformMessageId }),
    ...(row.targetLogicalMessageId === null ? {} : { targetLogicalMessageId: row.targetLogicalMessageId }),
    ...(row.senderMemberId === null ? {} : { senderMemberId: row.senderMemberId }),
    parts: row.parts,
    sourceTimestamp: row.sourceTimestamp,
    receivedAt: row.receivedAt,
    dedupeKey: row.dedupeKey,
    ...(row.facts === null ? {} : { facts: row.facts }),
    searchText: row.searchText,
  }
}

const episodeInsert = (record: EpisodeRecord): typeof episodes.$inferInsert => ({
  id: record.id,
  channelId: record.channelId,
  agentId: record.agentId,
  agentRevisionId: record.agentRevisionId,
  ...(record.dshSessionId === undefined ? {} : { dshSessionId: record.dshSessionId }),
  status: record.status,
  openedAtEventId: record.openedAtEventId,
  ...(record.lastAdmittedEventId === undefined ? {} : { lastAdmittedEventId: record.lastAdmittedEventId }),
  ...(record.closedAtEventId === undefined ? {} : { closedAtEventId: record.closedAtEventId }),
  ...(record.closedAt === undefined ? {} : { closedAt: record.closedAt }),
  ...(record.closeReason === undefined ? {} : { closeReason: record.closeReason }),
  createdAt: record.createdAt,
})

export function createRuntimeRepository(
  database: DrizzleCoreDatabase,
): RuntimeSlice & AdapterRuntimeStateStore & DshSessionStorageMaintenance {
  const getEpisode = (id: EpisodeId): EpisodeRecord | undefined => {
    const row = database.select().from(episodes).where(eq(episodes.id, id)).get()
    return row === undefined ? undefined : toEpisode(row)
  }
  const admission = (id: AdmissionId): AdmissionRecord | undefined => {
    const candidate = database.select().from(admissions).where(eq(admissions.id, id)).get()
    if (candidate === undefined) return undefined
    const row = AdmissionRowSchema.parse(candidate)
    const eventIds = database
      .select({ id: admissionEvents.eventId })
      .from(admissionEvents)
      .where(eq(admissionEvents.admissionId, id))
      .orderBy(asc(admissionEvents.position))
      .all()
      .map(({ id: eventId }) => eventId)
    return {
      id: row.id,
      episodeId: row.episodeId,
      eventIds,
      mode: row.mode,
      state: row.state,
      ...(row.dshMessageId === null ? {} : { dshMessageId: row.dshMessageId }),
      createdAt: row.createdAt,
    }
  }

  return {
    getEpisode,
    getActiveEpisode(channelId: ChannelId, agentId: AgentId): EpisodeRecord | undefined {
      const candidate = database
        .select()
        .from(episodes)
        .where(
          and(
            eq(episodes.channelId, channelId),
            eq(episodes.agentId, agentId),
            inArray(episodes.status, ['opening', 'active']),
          ),
        )
        .get()
      return candidate === undefined ? undefined : toEpisode(candidate)
    },
    listRecoverableEpisodes(): readonly EpisodeRecord[] {
      return database
        .select()
        .from(episodes)
        .where(inArray(episodes.status, ['opening', 'active']))
        .orderBy(asc(episodes.createdAt), asc(episodes.id))
        .all()
        .map(toEpisode)
    },
    listActiveEpisodesForAgent(agentId: AgentId): readonly EpisodeRecord[] {
      return database
        .select()
        .from(episodes)
        .where(and(eq(episodes.agentId, agentId), eq(episodes.status, 'active')))
        .orderBy(asc(episodes.createdAt), asc(episodes.id))
        .all()
        .map(toEpisode)
    },
    retireDshSessionEpisodes(closedAt): DshSessionStorageRetirementReport {
      if (!Number.isSafeInteger(closedAt) || closedAt < 0)
        throw new TypeError('Episode close time must be non-negative.')
      return database.transaction(
        (tx) => {
          const live = tx
            .select()
            .from(episodes)
            .where(inArray(episodes.status, ['opening', 'active']))
            .orderBy(asc(episodes.createdAt), asc(episodes.id))
            .all()
            .map(toEpisode)
          if (live.length === 0) return { episodesClosed: 0, admissionsReleased: 0 }
          const episodeIds = live.map(({ id }) => id)
          const unresolved = tx
            .select({ id: admissions.id })
            .from(admissions)
            .where(and(inArray(admissions.episodeId, episodeIds), inArray(admissions.state, ['pending', 'claimed'])))
            .all()
          const admissionIds = unresolved.map(({ id }) => id)
          if (admissionIds.length > 0) {
            tx.delete(admissionEvents).where(inArray(admissionEvents.admissionId, admissionIds)).run()
            tx.delete(admissions).where(inArray(admissions.id, admissionIds)).run()
          }
          for (const episode of live) {
            const changed = tx
              .update(episodes)
              .set({
                status: 'closed',
                closeReason: 'incompatible-session-storage',
                closedAtEventId: episode.lastAdmittedEventId ?? episode.openedAtEventId,
                closedAt,
              })
              .where(and(eq(episodes.id, episode.id), inArray(episodes.status, ['opening', 'active'])))
              .run().changes
            if (changed !== 1) throw new Error(`Episode storage-reset conflict: ${episode.id}`)
          }
          return { episodesClosed: live.length, admissionsReleased: admissionIds.length }
        },
        { behavior: 'immediate' },
      )
    },
    getEpisodeHandoffTo(episodeId: EpisodeId): EpisodeHandoffRecord | undefined {
      const candidate = database.select().from(episodeHandoffs).where(eq(episodeHandoffs.toEpisodeId, episodeId)).get()
      if (candidate === undefined) return undefined
      const row = EpisodeHandoffRowSchema.parse(candidate)
      const links = database
        .select()
        .from(episodeHandoffEvents)
        .where(eq(episodeHandoffEvents.handoffId, row.id))
        .orderBy(asc(episodeHandoffEvents.role), asc(episodeHandoffEvents.position))
        .all()
        .map((link) => EpisodeHandoffEventRowSchema.parse(link))
      return {
        id: row.id,
        fromEpisodeId: row.fromEpisodeId,
        toEpisodeId: row.toEpisodeId,
        sourceEventIds: links.filter(({ role }) => role === 'source').map(({ eventId }) => eventId),
        recentEventIds: links.filter(({ role }) => role === 'recent').map(({ eventId }) => eventId),
        summary: row.summary,
        provider: row.provider,
        model: row.model,
        createdAt: row.createdAt,
      }
    },
    createEpisode(record): void {
      database.insert(episodes).values(episodeInsert(record)).run()
    },
    activateEpisode(id, dshSessionId): EpisodeRecord {
      const changed = database
        .update(episodes)
        .set({ status: 'active', dshSessionId })
        .where(and(eq(episodes.id, id), eq(episodes.status, 'opening')))
        .run().changes
      if (changed !== 1) throw new Error(`Episode is not opening: ${id}`)
      const record = getEpisode(id)
      if (record === undefined) throw new Error(`Episode disappeared: ${id}`)
      return record
    },
    updateEpisodeRevision(id, expectedRevisionId: AgentRevisionId, targetRevisionId: AgentRevisionId): EpisodeRecord {
      const changed = database
        .update(episodes)
        .set({ agentRevisionId: targetRevisionId })
        .where(
          and(eq(episodes.id, id), eq(episodes.status, 'active'), eq(episodes.agentRevisionId, expectedRevisionId)),
        )
        .run().changes
      if (changed !== 1) throw new Error(`Episode Revision transition conflict: ${id}`)
      const record = getEpisode(id)
      if (record === undefined) throw new Error(`Episode disappeared: ${id}`)
      return record
    },
    closeEpisode(id, reason: EpisodeCloseReason, closedAtEventId: ChannelEventId, closedAt: number): EpisodeRecord {
      const changed = database
        .update(episodes)
        .set({ status: 'closed', closeReason: reason, closedAtEventId, closedAt })
        .where(and(eq(episodes.id, id), inArray(episodes.status, ['opening', 'active'])))
        .run().changes
      if (changed !== 1) throw new Error(`Episode is not live: ${id}`)
      const record = getEpisode(id)
      if (record === undefined) throw new Error(`Episode disappeared: ${id}`)
      return record
    },
    commitEpisodeRollover(input): void {
      database.transaction(
        (tx) => {
          const changed = tx
            .update(episodes)
            .set({
              status: 'closed',
              closeReason: input.reason,
              closedAtEventId: input.closedAtEventId,
              closedAt: input.closedAt,
            })
            .where(and(eq(episodes.id, input.fromEpisodeId), eq(episodes.status, 'active')))
            .run().changes
          if (changed !== 1) throw new Error(`Episode rollover conflict: ${input.fromEpisodeId}`)
          tx.insert(episodes).values(episodeInsert(input.nextEpisode)).run()
          tx.insert(episodeHandoffs)
            .values({
              id: input.handoff.id,
              fromEpisodeId: input.handoff.fromEpisodeId,
              toEpisodeId: input.handoff.toEpisodeId,
              summary: input.handoff.summary,
              provider: input.handoff.provider,
              model: input.handoff.model,
              createdAt: input.handoff.createdAt,
            })
            .run()
          const links = [
            ...input.handoff.sourceEventIds.map((eventId, position) => ({
              handoffId: input.handoff.id,
              eventId,
              role: 'source' as const,
              position,
            })),
            ...input.handoff.recentEventIds.map((eventId, position) => ({
              handoffId: input.handoff.id,
              eventId,
              role: 'recent' as const,
              position,
            })),
          ]
          if (links.length > 0) tx.insert(episodeHandoffEvents).values(links).run()
        },
        { behavior: 'immediate' },
      )
    },
    failEpisode(id): void {
      if (
        database
          .update(episodes)
          .set({ status: 'failed' })
          .where(and(eq(episodes.id, id), eq(episodes.status, 'opening')))
          .run().changes !== 1
      ) {
        throw new Error(`Episode is not opening: ${id}`)
      }
    },
    createAdmission(record): void {
      if (record.eventIds.length === 0) throw new Error('Admission requires at least one Event.')
      database.transaction(
        (tx) => {
          tx.insert(admissions)
            .values({
              id: record.id,
              episodeId: record.episodeId,
              mode: record.mode,
              state: record.state,
              ...(record.dshMessageId === undefined ? {} : { dshMessageId: record.dshMessageId }),
              createdAt: record.createdAt,
            })
            .run()
          tx.insert(admissionEvents)
            .values(record.eventIds.map((eventId, position) => ({ admissionId: record.id, eventId, position })))
            .run()
        },
        { behavior: 'immediate' },
      )
    },
    listRecoverableAdmissions(episodeId): readonly AdmissionRecord[] {
      return database
        .select({ id: admissions.id })
        .from(admissions)
        .where(and(eq(admissions.episodeId, episodeId), inArray(admissions.state, ['pending', 'claimed'])))
        .orderBy(asc(admissions.createdAt), asc(admissions.id))
        .all()
        .flatMap(({ id }) => {
          const record = admission(id)
          return record === undefined ? [] : [record]
        })
    },
    listAdmittedEvents(episodeId, limit): readonly ChannelEventRecord[] {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('Invalid Episode Event limit.')
      return database
        .select({ event: channelEvents })
        .from(admissionEvents)
        .innerJoin(admissions, eq(admissions.id, admissionEvents.admissionId))
        .innerJoin(channelEvents, eq(channelEvents.id, admissionEvents.eventId))
        .where(eq(admissions.episodeId, episodeId))
        .orderBy(desc(channelEvents.receivedAt), desc(channelEvents.id))
        .limit(limit)
        .all()
        .reverse()
        .map(({ event }) => toChannelEvent(event))
    },
    listUnadmittedEvents(channelId, agentId, boundAt): readonly ChannelEventRecord[] {
      const pageSize = 200
      const result: ChannelEventRecord[] = []
      let cursor: { readonly receivedAt: number; readonly id: ChannelEventId } | undefined
      for (;;) {
        const alreadyAdmitted = database
          .select({ present: sql`1` })
          .from(admissionEvents)
          .innerJoin(admissions, eq(admissions.id, admissionEvents.admissionId))
          .innerJoin(episodes, eq(episodes.id, admissions.episodeId))
          .where(
            and(
              eq(admissionEvents.eventId, channelEvents.id),
              eq(episodes.channelId, channelId),
              eq(episodes.agentId, agentId),
            ),
          )
        const rows = database
          .select()
          .from(channelEvents)
          .where(
            and(
              eq(channelEvents.channelId, channelId),
              inArray(channelEvents.kind, ['message-created', 'message-edited', 'control']),
              gte(channelEvents.receivedAt, boundAt),
              notExists(alreadyAdmitted),
              cursor === undefined
                ? undefined
                : or(
                    gt(channelEvents.receivedAt, cursor.receivedAt),
                    and(eq(channelEvents.receivedAt, cursor.receivedAt), gt(channelEvents.id, cursor.id)),
                  ),
            ),
          )
          .orderBy(asc(channelEvents.receivedAt), asc(channelEvents.id))
          .limit(pageSize)
          .all()
        result.push(...rows.map(toChannelEvent))
        const last = rows.at(-1)
        if (last === undefined || rows.length < pageSize) return result
        cursor = { receivedAt: last.receivedAt, id: last.id }
      }
    },
    claimAdmission(id): void {
      if (
        database
          .update(admissions)
          .set({ state: 'claimed' })
          .where(and(eq(admissions.id, id), eq(admissions.state, 'pending')))
          .run().changes !== 1
      ) {
        throw new Error(`Admission is not pending: ${id}`)
      }
    },
    completeAdmission(id, dshMessageId, eventId): void {
      database.transaction(
        (tx) => {
          const row = tx.select({ episodeId: admissions.episodeId }).from(admissions).where(eq(admissions.id, id)).get()
          if (row === undefined) throw new Error(`Unknown Admission: ${id}`)
          const changed = tx
            .update(admissions)
            .set({ state: 'logged-to-session', dshMessageId })
            .where(and(eq(admissions.id, id), eq(admissions.state, 'claimed')))
            .run().changes
          if (changed !== 1) throw new Error(`Admission is not claimed: ${id}`)
          tx.update(episodes).set({ lastAdmittedEventId: eventId }).where(eq(episodes.id, row.episodeId)).run()
        },
        { behavior: 'immediate' },
      )
    },
    load(connectionId, key): Promise<JsonValue | undefined> {
      const candidate = database
        .select()
        .from(connectionState)
        .where(eq(connectionState.connectionId, connectionId))
        .get()
      if (candidate === undefined) return Promise.resolve(undefined)
      const state = ConnectionStateRowSchema.parse(candidate).state
      if (typeof state !== 'object' || state === null || Array.isArray(state)) return Promise.resolve(undefined)
      return Promise.resolve(state[key])
    },
    save(connectionId, key, value, updatedAt): Promise<void> {
      const row = database.select().from(connectionState).where(eq(connectionState.connectionId, connectionId)).get()
      const current = row === undefined ? {} : ConnectionStateRowSchema.parse(row).state
      const object = typeof current === 'object' && current !== null && !Array.isArray(current) ? current : {}
      database
        .insert(connectionState)
        .values({ connectionId, state: { ...object, [key]: value }, updatedAt })
        .onConflictDoUpdate({
          target: connectionState.connectionId,
          set: { state: { ...object, [key]: value }, updatedAt },
        })
        .run()
      return Promise.resolve()
    },
    clear(connectionId, key): Promise<void> {
      const candidate = database
        .select()
        .from(connectionState)
        .where(eq(connectionState.connectionId, connectionId))
        .get()
      if (candidate === undefined) return Promise.resolve()
      const row = ConnectionStateRowSchema.parse(candidate)
      const current = row.state
      if (typeof current !== 'object' || current === null || Array.isArray(current)) return Promise.resolve()
      const next = Object.fromEntries(Object.entries(current).filter(([candidate]) => candidate !== key))
      database
        .update(connectionState)
        .set({ state: next, updatedAt: row.updatedAt })
        .where(eq(connectionState.connectionId, connectionId))
        .run()
      return Promise.resolve()
    },
  }
}
