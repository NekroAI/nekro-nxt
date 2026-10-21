import { z } from 'zod'
import { AgentIdSchema, ChannelIdSchema, LinkedAccountIdSchema } from './domain.js'

/**
 * Linked accounts (设置 → 关联账号): third-party accounts that agents' commands act as. The library only keeps them;
 * an agent's commands receive an account only through its `commandAccounts` grant (命令账号授权 A1、A2). Tokens are
 * write-only; every view below carries metadata only.
 */

/** Platforms the host can link accounts of; each grant names one account per platform. */
export const LinkedAccountPlatformIdSchema = z.enum(['github'])
export type LinkedAccountPlatformId = z.output<typeof LinkedAccountPlatformIdSchema>

/** How an account is added: a typed token, or the token of a login the platform's local CLI holds (read once). */
export const LinkedAccountMethodSchema = z.enum(['token', 'gh-login'])
export type LinkedAccountMethod = z.output<typeof LinkedAccountMethodSchema>

/** A login the local `gh` holds, offered as a quick way to link a GitHub account. */
export const LocalGithubLoginSchema = z.object({ login: z.string().trim().min(1), active: z.boolean() }).strict()

const tokenFields = { method: z.literal('token'), token: z.string().trim().min(1).max(512) }
const ghLoginFields = { method: z.literal('gh-login'), login: z.string().trim().min(1).max(128) }

/** Where a token comes from: typed, or read once from a login of the platform's local CLI. */
export const LinkedAccountTokenSourceSchema = z.discriminatedUnion('method', [
  z.object(tokenFields).strict(),
  z.object(ghLoginFields).strict(),
])
export type LinkedAccountTokenSource = z.output<typeof LinkedAccountTokenSourceSchema>

export const LinkedAccountViewSchema = z
  .object({
    id: LinkedAccountIdSchema,
    platform: LinkedAccountPlatformIdSchema,
    /** The account name on the platform, as the platform reported it when the token was verified. */
    login: z.string(),
    /** Token scopes where the platform reports them (GitHub classic tokens); `null` otherwise. */
    scopes: z.array(z.string()).nullable(),
    source: LinkedAccountMethodSchema,
    /** False when the stored token cannot be read any more; the account stays so it can be replaced or removed. */
    available: z.boolean(),
    /** Agents whose capabilities grant this account. */
    grantedAgentIds: z.array(AgentIdSchema),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    lastUsedAt: z.number().int().nonnegative().nullable(),
  })
  .strict()
export type LinkedAccountView = z.output<typeof LinkedAccountViewSchema>

/** Links an account: the platform plus how its token is given. */
export const AddLinkedAccountRequestSchema = z.discriminatedUnion('method', [
  z.object({ platform: LinkedAccountPlatformIdSchema, ...tokenFields }).strict(),
  z.object({ platform: LinkedAccountPlatformIdSchema, ...ghLoginFields }).strict(),
])
export type AddLinkedAccountRequest = z.output<typeof AddLinkedAccountRequestSchema>

/** A new token for an account; it must belong to the same account on the platform. */
export const ReplaceLinkedAccountTokenRequestSchema = LinkedAccountTokenSourceSchema
export type ReplaceLinkedAccountTokenRequest = z.output<typeof ReplaceLinkedAccountTokenRequestSchema>

/** Removing a granted account needs `confirm`; without it the result lists the agents it is granted to. */
export const RemoveLinkedAccountRequestSchema = z.object({ confirm: z.boolean().default(false) }).strict()

/** One recorded use: an agent's command environment carried the account. Newest 500 per account, none over 90 days. */
export const LinkedAccountUseSchema = z
  .object({
    at: z.number().int().nonnegative(),
    agentId: AgentIdSchema.nullable(),
    channelId: ChannelIdSchema.nullable(),
    consumerKind: z.enum(['command']),
    consumerId: z.string(),
  })
  .strict()
export type LinkedAccountUse = z.output<typeof LinkedAccountUseSchema>

export const LinkedAccountUsesViewSchema = z.object({ uses: z.array(LinkedAccountUseSchema) }).strict()
