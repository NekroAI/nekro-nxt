import { and, eq } from 'drizzle-orm'
import type { ExtensionId, ExtensionRevisionId } from '@nekro-nxt/contracts'
import type { DrizzleCoreDatabase } from '../database.js'
import { extensionCommunityLinks, extensionRevisionReleases } from '../schema.js'

/** The community release one local Revision corresponds to on one community. */
export type ExtensionRevisionReleaseRecord = {
  readonly revisionId: ExtensionRevisionId
  readonly extensionId: ExtensionId
  readonly communityUrl: string
  readonly releaseId: string
  readonly releaseNumber: number | null
  readonly publisherHandle: string
  /** `install`: downloaded from the community; `publish`: published from this machine. */
  readonly via: 'install' | 'publish'
  readonly recordedAt: number
}

/** Whether this machine may publish an extension line on a community or only follows it. */
export type ExtensionCommunityLinkRecord = {
  readonly extensionId: ExtensionId
  readonly communityUrl: string
  readonly role: 'owner' | 'subscriber'
  readonly dismissedReleaseId: string | null
  readonly updatedAt: number
}

/** Release records and community links; both disappear with the Revision or extension they belong to. */
export function createExtensionSourcesRepository(database: DrizzleCoreDatabase) {
  const linkWhere = (extensionId: ExtensionId, communityUrl: string) =>
    and(eq(extensionCommunityLinks.extensionId, extensionId), eq(extensionCommunityLinks.communityUrl, communityUrl))
  return {
    listExtensionRevisionReleases(extensionId?: ExtensionId): ExtensionRevisionReleaseRecord[] {
      const query = database.select().from(extensionRevisionReleases)
      return (
        extensionId === undefined ? query : query.where(eq(extensionRevisionReleases.extensionId, extensionId))
      ).all()
    },
    getExtensionRevisionRelease(
      revisionId: ExtensionRevisionId,
      communityUrl: string,
    ): ExtensionRevisionReleaseRecord | undefined {
      return database
        .select()
        .from(extensionRevisionReleases)
        .where(
          and(
            eq(extensionRevisionReleases.revisionId, revisionId),
            eq(extensionRevisionReleases.communityUrl, communityUrl),
          ),
        )
        .get()
    },
    /** The first record of a Revision on a community stays; installing it again does not rewrite where it came from. */
    recordExtensionRevisionRelease(record: ExtensionRevisionReleaseRecord): void {
      database.insert(extensionRevisionReleases).values(record).onConflictDoNothing().run()
    },
    listExtensionCommunityLinks(extensionId?: ExtensionId): ExtensionCommunityLinkRecord[] {
      const query = database.select().from(extensionCommunityLinks)
      return (
        extensionId === undefined ? query : query.where(eq(extensionCommunityLinks.extensionId, extensionId))
      ).all()
    },
    getExtensionCommunityLink(
      extensionId: ExtensionId,
      communityUrl: string,
    ): ExtensionCommunityLinkRecord | undefined {
      return database.select().from(extensionCommunityLinks).where(linkWhere(extensionId, communityUrl)).get()
    },
    /** Owner is never downgraded by a later install; only an explicit correction (`force`) makes it a subscriber. */
    upsertExtensionCommunityLink(input: {
      readonly extensionId: ExtensionId
      readonly communityUrl: string
      readonly role: 'owner' | 'subscriber'
      readonly now: number
      readonly force?: boolean
    }): void {
      database.transaction((tx) => {
        const current = tx
          .select()
          .from(extensionCommunityLinks)
          .where(linkWhere(input.extensionId, input.communityUrl))
          .get()
        if (current === undefined) {
          tx.insert(extensionCommunityLinks)
            .values({
              extensionId: input.extensionId,
              communityUrl: input.communityUrl,
              role: input.role,
              dismissedReleaseId: null,
              updatedAt: input.now,
            })
            .run()
          return
        }
        const role = input.force === true || input.role === 'owner' ? input.role : current.role
        if (role === current.role) return
        tx.update(extensionCommunityLinks)
          .set({ role, updatedAt: input.now })
          .where(linkWhere(input.extensionId, input.communityUrl))
          .run()
      })
    },
    /** Remember that the user keeps local changes over one community release; null clears it. */
    dismissExtensionCommunityRelease(input: {
      readonly extensionId: ExtensionId
      readonly communityUrl: string
      readonly releaseId: string | null
      readonly now: number
    }): void {
      database
        .update(extensionCommunityLinks)
        .set({ dismissedReleaseId: input.releaseId, updatedAt: input.now })
        .where(linkWhere(input.extensionId, input.communityUrl))
        .run()
    },
  }
}

export type ExtensionSourcesRepository = ReturnType<typeof createExtensionSourcesRepository>
