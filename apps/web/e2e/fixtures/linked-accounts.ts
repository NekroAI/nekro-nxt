import {
  LinkedAccountIdSchema,
  LinkedAccountsViewSchema,
  type AgentId,
  type LinkedAccountsView,
  type LinkedAccountUse,
} from '@nekro-nxt/contracts'
import { targetAgentId, targetChannelId } from './product-quality.js'

export const octoAccountId = LinkedAccountIdSchema.parse('acc_octofixture')
export const botAccountId = LinkedAccountIdSchema.parse('acc_botfixture')
export const addedAccountId = LinkedAccountIdSchema.parse('acc_addedfixture')

const minute = 60_000

/**
 * Linked accounts of a fictional host: one GitHub account granted to `grantedTo` with classic scopes, one
 * fine-grained token nobody uses, a local `gh` with two logins, and a GitHub CLI found on the device.
 */
export const linkedAccountsView = (
  options: { readonly grantedTo?: readonly AgentId[]; readonly empty?: boolean; readonly now?: number } = {},
): LinkedAccountsView => {
  const now = options.now ?? Date.now()
  return LinkedAccountsViewSchema.parse({
    platforms: [
      {
        id: 'github',
        name: 'GitHub',
        addMethods: ['token', 'gh-login'],
        tool: {
          id: 'github-cli',
          name: 'GitHub CLI',
          availability: { available: true, source: 'system', version: '2.90.0' },
        },
        accounts: options.empty
          ? []
          : [
              {
                id: octoAccountId,
                platform: 'github',
                login: 'octo-fixture',
                scopes: ['repo', 'read:org'],
                source: 'token',
                available: true,
                grantedAgentIds: options.grantedTo ?? [targetAgentId],
                createdAt: now - 3 * 86_400_000,
                updatedAt: now - 86_400_000,
                lastUsedAt: now - 12 * minute,
              },
              {
                id: botAccountId,
                platform: 'github',
                login: 'example-bot',
                scopes: null,
                source: 'gh-login',
                available: true,
                grantedAgentIds: [],
                createdAt: now - 2 * 86_400_000,
                updatedAt: now - 2 * 86_400_000,
                lastUsedAt: null,
              },
            ],
      },
    ],
    localGithubLogins: [
      { login: 'example-bot', active: true },
      { login: 'example-helper', active: false },
    ],
  })
}

export const octoUses = (now = Date.now()): readonly LinkedAccountUse[] => [
  {
    at: now - 12 * minute,
    agentId: targetAgentId,
    channelId: targetChannelId,
    consumerKind: 'command',
    consumerId: 'bash',
  },
  { at: now - 3 * 60 * minute, agentId: targetAgentId, channelId: null, consumerKind: 'command', consumerId: 'bash' },
]
