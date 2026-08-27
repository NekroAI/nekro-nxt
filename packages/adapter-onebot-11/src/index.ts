export * from './definition.js'
export * from './runtime.js'
export * from './transport.js'

import type { AdapterHostContributionV1 } from '@nekro-nxt/adapter-sdk'
import {
  ONEBOT_11_CONNECTION_DEFINITION,
  OneBot11ConnectionConfigurationSchema,
  OneBot11RuntimeConfigSchema,
} from './definition.js'
import { OneBot11Runtime, type OneBot11RuntimeOptions } from './runtime.js'

export const createOneBot11HostContribution = (
  transport?: OneBot11RuntimeOptions['transport'],
): AdapterHostContributionV1 => ({
  apiVersion: 1,
  descriptor: ONEBOT_11_CONNECTION_DEFINITION.descriptor,
  create: (context, stored) =>
    Promise.resolve(
      new OneBot11Runtime({
        context,
        config: OneBot11RuntimeConfigSchema.parse({
          ...OneBot11ConnectionConfigurationSchema.parse(stored.configuration),
          ...(stored.credentialRefs['accessToken'] === undefined
            ? {}
            : { accessTokenCredentialRef: stored.credentialRefs['accessToken'] }),
        }),
        ...(transport === undefined ? {} : { transport }),
      }),
    ),
})
