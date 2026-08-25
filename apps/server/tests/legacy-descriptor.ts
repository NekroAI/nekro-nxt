import { ServerInstanceIdSchema } from '@nekro-nxt/contracts'
import { z } from 'zod'

/** Frozen descriptor shape accepted by the protocol-1 Desktop released before explicit remote HTTP support. */
export const LegacyDesktopProtocol1DescriptorSchema = z
  .object({
    format: z.literal('nxt.instance-descriptor'),
    descriptorVersion: z.literal(1),
    instanceId: ServerInstanceIdSchema,
    releaseId: z.string().trim().min(1).max(256),
    productVersion: z.string().trim().min(1).max(64),
    managementProtocol: z.literal(1),
    desktopChromeProtocol: z.literal(1),
    transport: z.enum(['loopback-http', 'auto-tls-pinned-v1']),
  })
  .strict()
