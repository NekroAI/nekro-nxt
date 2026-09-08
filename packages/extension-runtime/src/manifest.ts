import {
  AdapterClientSlotNameSchema,
  AgentClientSlotNameSchema,
  ExtensionIdSchema,
  ExtensionRevisionIdSchema,
  HostPageContributionSchema,
  HostUiPermissionDeclarationSchema,
} from '@nekro-nxt/contracts'
import { z } from 'zod'
export const extensionEntrypointsSchema = z.union([
  z.object({ host: z.literal('source/host.ts'), client: z.literal('source/client.ts') }).strict(),
  z.object({ host: z.literal('source/host.ts') }).strict(),
  z.object({ client: z.literal('source/client.ts') }).strict(),
])

export const clientCssSchema = z
  .object({
    path: z.string().regex(/^assets\/[a-z0-9][a-z0-9/_-]*\.module\.css$/u),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()

const manifestIdentitySchema = z
  .object({
    extensionId: ExtensionIdSchema,
    revisionId: ExtensionRevisionIdSchema,
    entrypoints: extensionEntrypointsSchema,
  })
  .strict()

export const extensionManifestSchema = z.union([
  manifestIdentitySchema
    .extend({
      schemaVersion: z.literal(5),
      scope: z.literal('agent'),
      contributions: z.array(
        z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('tool'), name: z.string(), description: z.string() }).strict(),
          z.object({ kind: z.literal('rpc'), method: z.string() }).strict(),
          z
            .object({
              kind: z.literal('client-slot'),
              name: AgentClientSlotNameSchema,
            })
            .strict(),
        ]),
      ),
    })
    .strict(),
  manifestIdentitySchema
    .extend({
      schemaVersion: z.literal(5),
      scope: z.literal('host-adapter'),
      entrypoints: z.union([
        z.object({ host: z.literal('source/host.ts'), client: z.literal('source/client.ts') }).strict(),
        z.object({ host: z.literal('source/host.ts') }).strict(),
      ]),
      clientCss: clientCssSchema.optional(),
      contributions: z
        .array(
          z.discriminatedUnion('kind', [
            z
              .object({
                kind: z.literal('adapter'),
                apiVersion: z.literal(2),
                key: z.string().trim().min(1),
                descriptorDigest: z.string().regex(/^[a-f0-9]{64}$/u),
              })
              .strict(),
            z
              .object({
                kind: z.literal('host-client-slot'),
                name: AdapterClientSlotNameSchema,
                key: z.string().trim().min(1),
              })
              .strict(),
            HostPageContributionSchema,
          ]),
        )
        .min(1)
        .superRefine((contributions, context) => {
          if (contributions.filter(({ kind }) => kind === 'adapter').length !== 1) {
            context.addIssue({ code: 'custom', message: 'Host Adapter Manifest 必须且只能声明一个 Adapter。' })
          }
        }),
    })
    .strict(),
  manifestIdentitySchema
    .extend({
      schemaVersion: z.literal(5),
      scope: z.literal('host-ui'),
      entrypoints: z.union([
        z.object({ host: z.literal('source/host.ts'), client: z.literal('source/client.ts') }).strict(),
        z.object({ client: z.literal('source/client.ts') }).strict(),
      ]),
      clientCss: clientCssSchema.optional(),
      permissions: HostUiPermissionDeclarationSchema,
      contributions: z.array(HostPageContributionSchema).min(1).max(8),
    })
    .strict(),
])

export type ExtensionManifest = z.infer<typeof extensionManifestSchema>
