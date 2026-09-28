import { z } from 'zod'

export const RuntimeCompatibilityDiagnosticSchema = z
  .object({
    objectKind: z.enum(['agent', 'model-provider', 'extension', 'dsh-plugin', 'adapter', 'client-page']),
    objectId: z.string().min(1),
    objectVersion: z.string().min(1),
    configurationRevision: z.string(),
    runtimeFingerprint: z.string().min(1),
    status: z.enum(['checking', 'compatible', 'isolated']),
    phase: z.enum(['configuration', 'dependency', 'build', 'load', 'render', 'restore', 'dispose']),
    reason: z.string().max(2048).optional(),
    retryable: z.boolean(),
    checkedAt: z.number().int().nonnegative(),
  })
  .strict()
export type RuntimeCompatibilityDiagnostic = z.infer<typeof RuntimeCompatibilityDiagnosticSchema>

export const HostUpgradeSummarySchema = z
  .object({
    runtimeVersion: z.string().min(1),
    sessionCompatibilityId: z.string().min(1),
    backupId: z.string().optional(),
    resetContexts: z.boolean(),
    diagnostics: z.array(RuntimeCompatibilityDiagnosticSchema),
  })
  .strict()
export type HostUpgradeSummary = z.infer<typeof HostUpgradeSummarySchema>
