import type { ManagementDeviceId, ServerInstanceId } from '@nekro-nxt/contracts'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { CoreDatabase } from './database.js'
import {
  HostSecurityMetadataRowSchema,
  ManagementDeviceRowSchema,
  ManagementPasskeyRowSchema,
  PushSubscriptionRowSchema,
} from './row-schemas.js'
import { hostSecurityMetadata, managementDevices, managementPasskeys, pushSubscriptions } from './schema.js'

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

export interface PushSubscriptionRecord {
  readonly endpoint: string
  readonly deviceId: ManagementDeviceId
  readonly p256dh: string
  readonly auth: string
  readonly label: string
  readonly createdAt: number
  readonly lastDeliveredAt?: number
}

export interface ManagementPasskeyRecord {
  readonly id: string
  readonly rpId: string
  readonly publicKey: string
  readonly counter: number
  readonly transports?: readonly string[]
  readonly label: string
  readonly createdAt: number
  readonly lastUsedAt?: number
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

  /** True until the administrator turns browser sign-in with the management key off. */
  keySignIn(): boolean {
    const row = this.#db.select().from(hostSecurityMetadata).where(eq(hostSecurityMetadata.id, 1)).get()
    return row === undefined ? true : HostSecurityMetadataRowSchema.parse(row).keySignIn
  }

  setKeySignIn(enabled: boolean, updatedAt: number): void {
    this.#db
      .update(hostSecurityMetadata)
      .set({ keySignIn: enabled, updatedAt })
      .where(eq(hostSecurityMetadata.id, 1))
      .run()
  }

  putPasskey(record: Omit<ManagementPasskeyRecord, 'lastUsedAt'>): ManagementPasskeyRecord {
    this.#db
      .insert(managementPasskeys)
      .values({ ...record, transports: record.transports === undefined ? null : JSON.stringify(record.transports) })
      .run()
    return record
  }

  listPasskeys(rpId?: string): readonly ManagementPasskeyRecord[] {
    return this.#db
      .select()
      .from(managementPasskeys)
      .where(rpId === undefined ? undefined : eq(managementPasskeys.rpId, rpId))
      .all()
      .map((row) => this.#projectPasskey(row))
  }

  getPasskey(id: string): ManagementPasskeyRecord | undefined {
    const row = this.#db.select().from(managementPasskeys).where(eq(managementPasskeys.id, id)).get()
    return row === undefined ? undefined : this.#projectPasskey(row)
  }

  /** Records a successful sign-in; the authenticator's counter only moves forward. */
  usePasskey(id: string, counter: number, usedAt: number): void {
    this.#db.update(managementPasskeys).set({ counter, lastUsedAt: usedAt }).where(eq(managementPasskeys.id, id)).run()
  }

  deletePasskey(id: string): boolean {
    return this.#db.delete(managementPasskeys).where(eq(managementPasskeys.id, id)).run().changes > 0
  }

  #projectPasskey(row: typeof managementPasskeys.$inferSelect): ManagementPasskeyRecord {
    const parsed = ManagementPasskeyRowSchema.parse(row)
    const transports: unknown = parsed.transports === null ? undefined : JSON.parse(parsed.transports)
    return {
      id: parsed.id,
      rpId: parsed.rpId,
      publicKey: parsed.publicKey,
      counter: parsed.counter,
      ...(Array.isArray(transports) ? { transports: transports.filter((item) => typeof item === 'string') } : {}),
      label: parsed.label,
      createdAt: parsed.createdAt,
      ...(parsed.lastUsedAt === null ? {} : { lastUsedAt: parsed.lastUsedAt }),
    }
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

  /** Revoking a device also removes its push subscriptions. */
  revokeDevice(id: ManagementDeviceId, revokedAt: number): boolean {
    return this.#db.transaction((tx) => {
      const result = tx
        .update(managementDevices)
        .set({ revokedAt })
        .where(and(eq(managementDevices.id, id), isNull(managementDevices.revokedAt)))
        .run()
      tx.delete(pushSubscriptions).where(eq(pushSubscriptions.deviceId, id)).run()
      return result.changes > 0
    })
  }

  revokeAllDevices(revokedAt: number): number {
    return this.#db.transaction((tx) => {
      const changes = tx
        .update(managementDevices)
        .set({ revokedAt })
        .where(isNull(managementDevices.revokedAt))
        .run().changes
      tx.delete(pushSubscriptions).run()
      return changes
    })
  }

  /** Registers or moves a subscription; the same browser subscribing again keeps one row. */
  putPushSubscription(record: Omit<PushSubscriptionRecord, 'lastDeliveredAt'>): PushSubscriptionRecord {
    this.#db
      .insert(pushSubscriptions)
      .values(record)
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: { deviceId: record.deviceId, p256dh: record.p256dh, auth: record.auth, label: record.label },
      })
      .run()
    return this.listPushSubscriptions().find((entry) => entry.endpoint === record.endpoint)!
  }

  /** Subscriptions of active devices only. */
  listPushSubscriptions(): readonly PushSubscriptionRecord[] {
    return this.#db
      .select({ subscription: pushSubscriptions })
      .from(pushSubscriptions)
      .innerJoin(managementDevices, eq(managementDevices.id, pushSubscriptions.deviceId))
      .where(isNull(managementDevices.revokedAt))
      .all()
      .map(({ subscription }) => this.#projectPushSubscription(subscription))
  }

  deletePushSubscriptions(endpoints: readonly string[]): number {
    if (endpoints.length === 0) return 0
    return this.#db
      .delete(pushSubscriptions)
      .where(inArray(pushSubscriptions.endpoint, [...endpoints]))
      .run().changes
  }

  markPushDelivered(endpoint: string, deliveredAt: number): void {
    this.#db
      .update(pushSubscriptions)
      .set({ lastDeliveredAt: deliveredAt })
      .where(eq(pushSubscriptions.endpoint, endpoint))
      .run()
  }

  #projectPushSubscription(row: typeof pushSubscriptions.$inferSelect): PushSubscriptionRecord {
    const parsed = PushSubscriptionRowSchema.parse(row)
    return {
      endpoint: parsed.endpoint,
      deviceId: parsed.deviceId,
      p256dh: parsed.p256dh,
      auth: parsed.auth,
      label: parsed.label,
      createdAt: parsed.createdAt,
      ...(parsed.lastDeliveredAt === null ? {} : { lastDeliveredAt: parsed.lastDeliveredAt }),
    }
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
