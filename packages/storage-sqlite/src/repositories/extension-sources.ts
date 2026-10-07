import { eq } from 'drizzle-orm'
import type { ExtensionId, ExtensionRevisionId } from '@nekro-nxt/contracts'
import type { DrizzleCoreDatabase } from '../database.js'
import { extensionRevisionSources } from '../schema.js'

export type ExtensionRevisionSourceRecord = {
  readonly revisionId: ExtensionRevisionId
  readonly extensionId: ExtensionId
  readonly kind: 'community'
  readonly communityUrl: string
  readonly releaseId: string
  readonly publisherHandle: string
  readonly installedAt: number
}

/** Revision 来源；Revision 删除时随之删除。同一 Revision 再次从社区导入时保留第一次的记录。 */
export function createExtensionSourcesRepository(database: DrizzleCoreDatabase) {
  return {
    getExtensionRevisionSource(revisionId: ExtensionRevisionId): ExtensionRevisionSourceRecord | undefined {
      return database
        .select()
        .from(extensionRevisionSources)
        .where(eq(extensionRevisionSources.revisionId, revisionId))
        .get()
    },
    recordExtensionRevisionSource(record: ExtensionRevisionSourceRecord): void {
      database.insert(extensionRevisionSources).values(record).onConflictDoNothing().run()
    },
    listExtensionRevisionSources(): ExtensionRevisionSourceRecord[] {
      return database.select().from(extensionRevisionSources).all()
    },
  }
}

export type ExtensionSourcesRepository = ReturnType<typeof createExtensionSourcesRepository>
