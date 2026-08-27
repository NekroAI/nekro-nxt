export * from './definition.js'
export * from './runtime.js'
export * from './transport.js'

import type { AdapterHostContributionV1 } from '@nekro-nxt/adapter-sdk'
import {
  WECOM_AI_BOT_CONNECTION_DEFINITION,
  WeComAiBotConnectionConfigurationSchema,
  WeComAiBotRuntimeConfigSchema,
} from './definition.js'
import { WeComAiBotRuntime, type WeComAiBotRuntimeOptions } from './runtime.js'

export const createWeComAiBotHostContribution = (
  transport?: WeComAiBotRuntimeOptions['transport'],
): AdapterHostContributionV1 => ({
  apiVersion: 1,
  descriptor: WECOM_AI_BOT_CONNECTION_DEFINITION.descriptor,
  create: (context, stored) =>
    Promise.resolve(
      new WeComAiBotRuntime({
        context,
        config: WeComAiBotRuntimeConfigSchema.parse({
          ...WeComAiBotConnectionConfigurationSchema.parse(stored.configuration),
          secretCredentialRef: stored.credentialRefs['secret'],
        }),
        ...(transport === undefined ? {} : { transport }),
      }),
    ),
})
