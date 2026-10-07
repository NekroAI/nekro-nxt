import {
  extensionContributionSchema,
  extensionIconSchema,
  extensionManifestSchema,
  normalizeSource,
  revisionDigests,
  revisionResourcesSchema,
  revisionSourcesSchema,
  validateRevisionResources,
  type MaterializedExtensionRevision,
} from '@nekro-nxt/extension-format'
import {
  ExtensionConfigDeclarationSchema,
  HostUiPermissionDeclarationSchema,
  type ExtensionId,
  type ExtensionRevisionId,
} from '@nekro-nxt/contracts'
import { z } from 'zod'
import type { DynamicPackageSnapshot } from './types.js'

export { materializeImportedRevision } from '@nekro-nxt/extension-format'

const inputSchema = z
  .object({
    snapshot: z
      .object({
        name: z.string().trim().min(1).max(80),
        purpose: z.string().trim().min(1).max(500),
        hostCode: z
          .string()
          .max(1024 * 1024)
          .optional(),
        clientCode: z
          .string()
          .max(1024 * 1024)
          .optional(),
        permissions: HostUiPermissionDeclarationSchema.optional(),
        resources: z
          .record(z.string().regex(/^assets\/[a-z0-9][a-z0-9/_.-]*$/u), z.string().max(256 * 1024))
          .optional(),
        clientCss: z
          .object({
            path: z.string().regex(/^assets\/[a-z0-9][a-z0-9/_-]*\.module\.css$/u),
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
          })
          .strict()
          .optional(),
        icon: extensionIconSchema.optional(),
        config: ExtensionConfigDeclarationSchema.optional(),
        contributions: z.array(extensionContributionSchema).default([]),
      })
      .strict()
      .refine(({ hostCode, clientCode }) => hostCode !== undefined || clientCode !== undefined, {
        message: 'A dynamic Package snapshot needs a Host or Client source half.',
      }),
  })
  .strict()

const wrapHost = (body: string): string =>
  normalizeSource(`import { defineHostExtension } from '@nekro-nxt/extension-sdk'

export default defineHostExtension(async ({ harness }) => {
${body}
})`)

const wrapClient = (body: string, clientCssPath?: string): string =>
  normalizeSource(`${clientCssPath === undefined ? '' : `import '../${clientCssPath}?nxt-dynamic-css'\n`}
import { defineClientExtension } from '@nekro-nxt/extension-sdk'

export default defineClientExtension(async ({ React, host, styles }) => {
${body}
})`)

const AGENT_KINDS = new Set(['tool', 'rpc', 'panel', 'tool-view'])

/** Client CSS is scoped to this Revision's rendered UI, so it is only meaningful with a Client half. */
export const assertClientCssScope = (input: { readonly hasClientCss: boolean; readonly hasClient: boolean }): void => {
  if (input.hasClientCss && !input.hasClient) throw new Error('Client CSS 需要同时提交 Client 源码。')
}

export function materializeDynamicPackage(input: {
  readonly extensionId: ExtensionId
  readonly revisionId: ExtensionRevisionId
  readonly snapshot: DynamicPackageSnapshot
}): MaterializedExtensionRevision {
  const parsed = inputSchema.parse({
    snapshot: input.snapshot,
  })
  const contributions = parsed.snapshot.contributions
  const isHostAdapter = contributions.some(({ kind }) => kind === 'adapter' || kind === 'message-renderer')
  const hasAgentContribution = contributions.some(({ kind }) => AGENT_KINDS.has(kind))
  const isHostUi = !isHostAdapter && !hasAgentContribution && contributions.some(({ kind }) => kind === 'host-page')
  if (isHostAdapter && !parsed.snapshot.hostCode) throw new Error('适配器 Revision 必须包含 Host Adapter。')
  if (isHostAdapter && contributions.some(({ kind }) => kind === 'tool' || kind === 'rpc' || kind === 'tool-view')) {
    throw new Error('适配器 Revision 不能混装智能体工具、RPC 或工具视图，请拆分为两个扩展。')
  }
  if (!isHostAdapter && hasAgentContribution && contributions.some(({ kind }) => kind === 'host-page')) {
    throw new Error('智能体扩展不能贡献顶级页面，请拆分为两个扩展。')
  }
  if (isHostUi && !parsed.snapshot.clientCode) throw new Error('页面 Revision 必须包含 Client。')
  assertClientCssScope({
    hasClientCss: parsed.snapshot.clientCss !== undefined,
    hasClient: parsed.snapshot.clientCode !== undefined,
  })
  const sources = revisionSourcesSchema.parse({
    ...(parsed.snapshot.hostCode === undefined ? {} : { host: wrapHost(parsed.snapshot.hostCode) }),
    ...(parsed.snapshot.clientCode === undefined
      ? {}
      : { client: wrapClient(parsed.snapshot.clientCode, parsed.snapshot.clientCss?.path) }),
  })
  const scope = isHostAdapter ? 'host-adapter' : isHostUi ? 'host-ui' : 'agent'
  const manifest = extensionManifestSchema.parse({
    schemaVersion: 6,
    scope,
    extensionId: input.extensionId,
    revisionId: input.revisionId,
    entrypoints: {
      ...('host' in sources ? { host: 'source/host.ts' } : {}),
      ...('client' in sources ? { client: 'source/client.ts' } : {}),
    },
    ...(parsed.snapshot.clientCss === undefined ? {} : { clientCss: parsed.snapshot.clientCss }),
    ...(parsed.snapshot.icon === undefined ? {} : { icon: parsed.snapshot.icon }),
    permissions: parsed.snapshot.permissions ?? { permissions: [], networkOrigins: [] },
    ...(parsed.snapshot.config === undefined ? {} : { config: parsed.snapshot.config }),
    contributions,
  })
  const resources = revisionResourcesSchema.parse(parsed.snapshot.resources ?? {})
  validateRevisionResources(manifest, resources, '动态扩展')
  return { manifest, sources, resources, ...revisionDigests({ manifest, sources, resources }), scope }
}
