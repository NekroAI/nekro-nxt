import { z } from 'zod'
import { AgentIdSchema, ChannelIdSchema, CredentialIdSchema, ExtensionIdSchema } from './domain.js'
import { ExtensionNetworkDomainSchema } from './extension-capabilities.js'

/**
 * Named credentials (智能体扩展配置与凭据 C1–C5): one entry is added once and reused by extensions, MCP servers and
 * commands. The value is write-only; every view below carries metadata only.
 */

export const CREDENTIAL_NAME_MAX_CHARS = 64
export const CREDENTIAL_DESCRIPTION_MAX_CHARS = 500
export const CREDENTIAL_VALUE_MAX_CHARS = 16_384
/** Values shorter than this are not hidden from tool results; the form warns when one is saved. */
export const CREDENTIAL_REDACTABLE_MIN_CHARS = 8

/** How a credential reaches code: `request` only as a placeholder filled by `nxt.http.fetch`; `program` as the value. */
export const CredentialUsageSchema = z.enum(['request', 'program'])
export type CredentialUsage = z.output<typeof CredentialUsageSchema>

/** `github` entries are verified against GitHub and give commands `gh` and `git` access; the rest are `generic`. */
export const CredentialKindSchema = z.enum(['generic', 'github'])
export type CredentialKind = z.output<typeof CredentialKindSchema>

/** Agents that may use a credential: every agent, or the listed ones. */
export const CredentialAgentScopeSchema = z.union([
  z.object({ all: z.literal(true) }).strict(),
  z.object({ agentIds: z.array(AgentIdSchema).max(256) }).strict(),
])
export type CredentialAgentScope = z.output<typeof CredentialAgentScopeSchema>

/** Shown in redaction markers (`[凭据:名称]`), so brackets and control characters are not allowed. */
export const CredentialNameSchema = z
  .string()
  .trim()
  .min(1, '名称不能为空。')
  .max(CREDENTIAL_NAME_MAX_CHARS, `名称最多 ${CREDENTIAL_NAME_MAX_CHARS} 个字符。`)
  // eslint-disable-next-line no-control-regex -- Control characters are exactly what the name must not contain.
  .regex(/^[^\u0000-\u001f\u007f[\]]+$/u, '名称不能包含方括号或控制字符。')

export const CredentialDescriptionSchema = z
  .string()
  .trim()
  .max(CREDENTIAL_DESCRIPTION_MAX_CHARS, `说明最多 ${CREDENTIAL_DESCRIPTION_MAX_CHARS} 个字符。`)

export const CredentialDomainsSchema = z.array(ExtensionNetworkDomainSchema).max(32)

/** Names a credential's environment variable cannot take: the shell and the tools' own configuration. */
const RESERVED_COMMAND_ENV = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PWD',
  'OLDPWD',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'TERM',
  'NODE_OPTIONS',
  'NODE_PATH',
  'GH_CONFIG_DIR',
  'GH_PROMPT_DISABLED',
  'GIT_TERMINAL_PROMPT',
  'GIT_CONFIG_COUNT',
])
const RESERVED_COMMAND_ENV_PREFIXES = ['LC_', 'LD_', 'DYLD_', 'GIT_CONFIG_', 'NEKRO_', 'DSH_']

/** The environment variable a program credential reaches commands under. */
export const CredentialEnvNameSchema = z
  .string()
  .trim()
  .max(64)
  .regex(/^[A-Z_][A-Z0-9_]*$/u, '环境变量名只能使用大写字母、数字和下划线，且不能以数字开头。')
  .refine(
    (name) =>
      !RESERVED_COMMAND_ENV.has(name) && !RESERVED_COMMAND_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)),
    '这个环境变量名由系统使用，请换一个。',
  )

export const CredentialValueSchema = z.string().min(1).max(CREDENTIAL_VALUE_MAX_CHARS)

/** A login the local `gh` holds, offered as a quick way to add a GitHub credential. */
export const LocalGithubLoginSchema = z.object({ login: z.string().trim().min(1), active: z.boolean() }).strict()

/** Where a GitHub token comes from: typed, or read once from a login of the local `gh`. */
export const GithubCredentialSourceSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('token'), token: z.string().trim().min(1).max(512) }).strict(),
  z.object({ source: z.literal('gh-login'), login: z.string().trim().min(1).max(128) }).strict(),
])
export type GithubCredentialSource = z.output<typeof GithubCredentialSourceSchema>

/** Facts recorded about a GitHub credential when it was verified. */
export const CredentialMetadataSchema = z
  .object({
    login: z.string().optional(),
    /** Token scopes where GitHub reports them (classic tokens). */
    scopes: z.array(z.string()).optional(),
    source: z.enum(['token', 'gh-login']).optional(),
  })
  .strict()
export type CredentialMetadata = z.output<typeof CredentialMetadataSchema>

/** What uses one credential right now: extension secret fields bound to it and agents whose commands receive it. */
export const CredentialUsersSchema = z
  .object({
    extensions: z.array(
      z
        .object({
          extensionId: ExtensionIdSchema,
          name: z.string(),
          /** Agents whose own configuration binds it; empty when only the host configuration does. */
          agentIds: z.array(AgentIdSchema),
          host: z.boolean(),
        })
        .strict(),
    ),
    /** Agents with commands enabled whose commands receive it. */
    commandAgents: z.array(AgentIdSchema),
  })
  .strict()
export type CredentialUsers = z.output<typeof CredentialUsersSchema>

export const CredentialViewSchema = z
  .object({
    id: CredentialIdSchema,
    name: CredentialNameSchema,
    description: z.string(),
    kind: CredentialKindSchema,
    usage: CredentialUsageSchema,
    domains: z.array(z.string()),
    agentScope: CredentialAgentScopeSchema,
    autoUse: z.boolean(),
    /**
     * Program credentials: the environment variable agents' commands receive it under, or `null` when commands do
     * not receive it. GitHub credentials always reach commands as `GH_TOKEN`, with `gh` and `git` set up.
     */
    envName: z.string().nullable(),
    /** Agents an administrator let use it while automatic use is off. */
    approvedAgentIds: z.array(AgentIdSchema),
    /** False when the stored value is too short to hide from tool results, or cannot be read. */
    redactable: z.boolean(),
    /** False when the stored value cannot be read any more; the entry stays so it can be replaced. */
    available: z.boolean(),
    metadata: CredentialMetadataSchema,
    usedBy: CredentialUsersSchema,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    lastUsedAt: z.number().int().nonnegative().nullable(),
  })
  .strict()
export type CredentialView = z.output<typeof CredentialViewSchema>

/** A model provider listed with the credentials; `open` lets agents and extensions call it through the host. */
export const ModelProviderAccessSchema = z
  .object({
    provider: z.string().min(1),
    name: z.string(),
    open: z.boolean(),
  })
  .strict()
export type ModelProviderAccess = z.output<typeof ModelProviderAccessSchema>

/**
 * An agent asked for a credential that does not exist yet. The settings link pre-fills the add form; saving a
 * credential with this name wakes the agent in the channel it asked from.
 */
export const CredentialRequestViewSchema = z
  .object({
    id: z.string().min(1).max(64),
    name: CredentialNameSchema,
    purpose: z.string(),
    domains: z.array(z.string()),
    usage: CredentialUsageSchema,
    agentId: AgentIdSchema,
    channelId: ChannelIdSchema.nullable(),
    createdAt: z.number().int().nonnegative(),
    /** Settings route that opens the add form pre-filled, see {@link credentialRequestRoute}. */
    route: z.string(),
  })
  .strict()
export type CredentialRequestView = z.output<typeof CredentialRequestViewSchema>

export const CredentialsViewSchema = z
  .object({
    credentials: z.array(CredentialViewSchema),
    modelProviders: z.array(ModelProviderAccessSchema),
    requests: z.array(CredentialRequestViewSchema),
    /** Logins found in the local GitHub CLI; empty when it is missing or not logged in. */
    localGithubLogins: z.array(LocalGithubLoginSchema),
  })
  .strict()
export type CredentialsView = z.output<typeof CredentialsViewSchema>

const credentialMetaFields = {
  name: CredentialNameSchema,
  description: CredentialDescriptionSchema.default(''),
  agentScope: CredentialAgentScopeSchema.default({ all: true }),
  autoUse: z.boolean().default(true),
}

export const CreateCredentialRequestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('generic'),
      ...credentialMetaFields,
      usage: CredentialUsageSchema.default('request'),
      domains: CredentialDomainsSchema.default([]),
      /** Program credentials only. */
      envName: CredentialEnvNameSchema.optional(),
      value: CredentialValueSchema,
      /** The agent request this form was opened from, if any. */
      requestId: z.string().min(1).max(64).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('github'),
      ...credentialMetaFields,
      /** Defaults to `GitHub <login>`. */
      name: CredentialNameSchema.optional(),
      domains: CredentialDomainsSchema.optional(),
      github: GithubCredentialSourceSchema,
      requestId: z.string().min(1).max(64).optional(),
    })
    .strict(),
])
export type CreateCredentialRequest = z.input<typeof CreateCredentialRequestSchema>

/** Metadata changes; omitted fields keep their value. GitHub credentials always allow program use. */
export const UpdateCredentialRequestSchema = z
  .object({
    name: CredentialNameSchema.optional(),
    description: CredentialDescriptionSchema.optional(),
    usage: CredentialUsageSchema.optional(),
    domains: CredentialDomainsSchema.optional(),
    agentScope: CredentialAgentScopeSchema.optional(),
    autoUse: z.boolean().optional(),
    /** `null` stops giving it to commands; only program credentials take one. GitHub credentials use `GH_TOKEN`. */
    envName: CredentialEnvNameSchema.nullable().optional(),
    /** Replaces the agents allowed to use it while automatic use is off, for example to withdraw an approval. */
    approvedAgentIds: z.array(AgentIdSchema).max(256).optional(),
  })
  .strict()
export type UpdateCredentialRequest = z.output<typeof UpdateCredentialRequestSchema>

/** A new value; GitHub credentials only take a token of the same GitHub account. */
export const ReplaceCredentialValueRequestSchema = z.union([
  z.object({ value: CredentialValueSchema }).strict(),
  z.object({ github: GithubCredentialSourceSchema }).strict(),
])
export type ReplaceCredentialValueRequest = z.output<typeof ReplaceCredentialValueRequestSchema>

/** Removing a credential that is in use needs `confirm`; without it the result lists who uses it. */
export const RemoveCredentialRequestSchema = z.object({ confirm: z.boolean().default(false) }).strict()

export const RemoveCredentialResultSchema = z.discriminatedUnion('removed', [
  z.object({ removed: z.literal(true), view: CredentialsViewSchema }).strict(),
  z.object({ removed: z.literal(false), usedBy: CredentialUsersSchema }).strict(),
])
export type RemoveCredentialResult = z.output<typeof RemoveCredentialResultSchema>

export const CredentialConsumerKindSchema = z.enum(['extension', 'command', 'mcp', 'model'])

/** One recorded use. The newest 500 per credential are kept, none older than 90 days. */
export const CredentialUseSchema = z
  .object({
    at: z.number().int().nonnegative(),
    agentId: AgentIdSchema.nullable(),
    channelId: ChannelIdSchema.nullable(),
    requesterMemberId: z.string().nullable(),
    consumerKind: CredentialConsumerKindSchema,
    consumerId: z.string(),
    /** Extension display name or MCP server name, when it is still known. */
    consumerName: z.string().nullable(),
    targetHost: z.string().nullable(),
  })
  .strict()
export type CredentialUse = z.output<typeof CredentialUseSchema>

export const CredentialUsesViewSchema = z.object({ uses: z.array(CredentialUseSchema) }).strict()

export const SetModelProviderAccessRequestSchema = z.object({ open: z.boolean() }).strict()

/**
 * The settings route that opens the add form pre-filled from an agent's request: the credential section with `add=1`
 * plus `name`, `purpose`, `domains` (comma separated), `usage` and `request` (the request id) as query parameters.
 */
export const credentialRequestRoute = (request: {
  readonly id: string
  readonly name: string
  readonly purpose: string
  readonly domains: readonly string[]
  readonly usage: CredentialUsage
}): string => {
  const query = new URLSearchParams({ add: '1', name: request.name, request: request.id, usage: request.usage })
  if (request.purpose !== '') query.set('purpose', request.purpose)
  if (request.domains.length > 0) query.set('domains', request.domains.join(','))
  return `/settings/credentials?${query.toString()}`
}

/** Secret fields of an extension configuration layer bound to a named credential, by field. */
export const BoundCredentialsSchema = z.record(z.string(), CredentialIdSchema)

/** Binds secret fields to named credentials; `null` removes the binding and leaves the field unset. */
export const CredentialBindingsRequestSchema = z.record(z.string(), CredentialIdSchema.nullable())
