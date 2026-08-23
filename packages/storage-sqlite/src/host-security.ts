import type { ManagementDeviceId, ServerInstanceId } from '@nekro-nxt/contracts'
import { and, eq, isNull } from 'drizzle-orm'
import type { CoreDatabase } from './database.js'
import { HostSecurityMetadataRowSchema, ManagementDeviceRowSchema } from './row-schemas.js'
import { hostSecurityMetadata, managementDevices } from './schema.js'

export interface HostSecurityMetadataRecord {
  readonly instanceId: ServerInstanceId
  readonly managementKeyDigest: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface ManagementDeviceRecord {
  readonly id: ManagementDeviceId
  readonly label: string
  readonly secretDigest: string
  readonly createdAt: number
  readonly lastUsedAt?: number
  readonly revokedAt?: number
}

export class SqliteHostSecurityRepository {
  readonly #db

  constructor(database: CoreDatabase) {
    this.#db = database.db
  }

  getMetadata(): HostSecurityMetadataRecord | undefined {
    const row = this.#db.select().from(hostSecurityMetadata).where(eq(hostSecurityMetadata.id, 1)).get()
    if (row === undefined) return undefined
    const parsed = HostSecurityMetadataRowSchema.parse(row)
    return {
      instanceId: parsed.instanceId,
      managementKeyDigest: parsed.managementKeyDigest,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
    }
  }

  putMetadata(record: HostSecurityMetadataRecord): HostSecurityMetadataRecord {
    this.#db
      .insert(hostSecurityMetadata)
      .values({ id: 1, ...record })
      .onConflictDoUpdate({
        target: hostSecurityMetadata.id,
        set: {
          instanceId: record.instanceId,
          managementKeyDigest: record.managementKeyDigest,
          updatedAt: record.updatedAt,
        },
      })
      .run()
    return record
  }

  putDevice(record: ManagementDeviceRecord): ManagementDeviceRecord {
    this.#db.insert(managementDevices).values(record).run()
    return record
  }

  getActiveDevice(id: ManagementDeviceId): ManagementDeviceRecord | undefined {
    const row = this.#db
      .select()
      .from(managementDevices)
      .where(and(eq(managementDevices.id, id), isNull(managementDevices.revokedAt)))
      .get()
    return row === undefined ? undefined : this.#projectDevice(row)
  }

  listDevices(): readonly ManagementDeviceRecord[] {
    return this.#db
      .select()
      .from(managementDevices)
      .all()
      .map((row) => this.#projectDevice(row))
  }

  touchDevice(id: ManagementDeviceId, lastUsedAt: number): void {
    this.#db.update(managementDevices).set({ lastUsedAt }).where(eq(managementDevices.id, id)).run()
  }

  revokeDevice(id: ManagementDeviceId, revokedAt: number): boolean {
    const result = this.#db
      .update(managementDevices)
      .set({ revokedAt })
      .where(and(eq(managementDevices.id, id), isNull(managementDevices.revokedAt)))
      .run()
    return result.changes > 0
  }

  revokeAllDevices(revokedAt: number): number {
    return this.#db.update(managementDevices).set({ revokedAt }).where(isNull(managementDevices.revokedAt)).run()
      .changes
  }

  #projectDevice(row: typeof managementDevices.$inferSelect): ManagementDeviceRecord {
    const parsed = ManagementDeviceRowSchema.parse(row)
    return {
      id: parsed.id,
      label: parsed.label,
      secretDigest: parsed.secretDigest,
      createdAt: parsed.createdAt,
      ...(parsed.lastUsedAt === null ? {} : { lastUsedAt: parsed.lastUsedAt }),
      ...(parsed.revokedAt === null ? {} : { revokedAt: parsed.revokedAt }),
    }
  }
}
