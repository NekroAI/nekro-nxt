import { eq } from 'drizzle-orm'
import type { ChannelContextPolicy, ChannelId } from '@nekro-nxt/contracts'
import type { DrizzleCoreDatabase } from '../database.js'
import { channelContextPolicies } from '../schema.js'

export function createChannelContextPoliciesRepository(database: DrizzleCoreDatabase) {
  return {
    /** Undefined while the channel follows the defaults. */
    getChannelContextPolicy(channelId: ChannelId): ChannelContextPolicy | undefined {
      return database
        .select({ policy: channelContextPolicies.policy })
        .from(channelContextPolicies)
        .where(eq(channelContextPolicies.channelId, channelId))
        .get()?.policy
    },

    /** `undefined` removes the channel's own policy so it follows the defaults again. */
    saveChannelContextPolicy(channelId: ChannelId, policy: ChannelContextPolicy | undefined, updatedAt: number): void {
      if (policy === undefined) {
        database.delete(channelContextPolicies).where(eq(channelContextPolicies.channelId, channelId)).run()
        return
      }
      database
        .insert(channelContextPolicies)
        .values({ channelId, policy, updatedAt })
        .onConflictDoUpdate({ target: channelContextPolicies.channelId, set: { policy, updatedAt } })
        .run()
    },
  }
}

export type ChannelContextPoliciesRepository = ReturnType<typeof createChannelContextPoliciesRepository>
