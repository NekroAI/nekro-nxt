import {
  CredentialIdSchema,
  CredentialsViewSchema,
  credentialRequestRoute,
  type CredentialsView,
  type CredentialUse,
} from '@nekro-nxt/contracts'
import { productSnapshot, targetAgentId, targetChannelId, summaryExtensionId } from './product-quality.js'

export const weatherCredentialId = CredentialIdSchema.parse('crd_weatherfixture')
export const translateCredentialId = CredentialIdSchema.parse('crd_translatefixture')
export const githubCredentialId = CredentialIdSchema.parse('crd_githubfixture')
export const mapCredentialId = CredentialIdSchema.parse('crd_mapfixture')

const minute = 60_000

/** Named credentials of a fictional host: a request-only one in use, a program one waiting for approval, GitHub. */
export const credentialsView = (now = Date.now()): CredentialsView => {
  const request = {
    id: 'req_fixture1',
    name: '地图服务',
    purpose: '查询路线规划',
    domains: ['maps.example.com'],
    usage: 'request' as const,
  }
  return CredentialsViewSchema.parse({
    credentials: [
      {
        id: weatherCredentialId,
        name: '天气服务',
        description: '天气查询扩展使用的 API 密钥',
        kind: 'generic',
        usage: 'request',
        domains: ['api.weather.example.com'],
        agentScope: { all: true },
        autoUse: true,
        envName: null,
        approvedAgentIds: [],
        redactable: true,
        available: true,
        metadata: {},
        usedBy: {
          extensions: [
            {
              extensionId: summaryExtensionId,
              name: productSnapshot.extensions[0]?.displayName ?? '示例扩展',
              agentIds: [targetAgentId],
              host: false,
            },
          ],
          commandAgents: [],
        },
        createdAt: now - 3 * 86_400_000,
        updatedAt: now - 86_400_000,
        lastUsedAt: now - 5 * minute,
      },
      {
        id: translateCredentialId,
        name: '翻译服务',
        description: '',
        kind: 'generic',
        usage: 'program',
        domains: [],
        agentScope: { agentIds: [targetAgentId] },
        autoUse: false,
        envName: 'TRANSLATE_API_KEY',
        approvedAgentIds: [targetAgentId],
        redactable: true,
        available: true,
        metadata: {},
        usedBy: { extensions: [], commandAgents: [targetAgentId] },
        createdAt: now - 2 * 86_400_000,
        updatedAt: now - 2 * 86_400_000,
        lastUsedAt: null,
      },
      {
        id: githubCredentialId,
        name: '团队 GitHub',
        description: '',
        kind: 'github',
        usage: 'program',
        domains: ['github.com', 'api.github.com'],
        agentScope: { all: true },
        autoUse: true,
        envName: null,
        approvedAgentIds: [],
        redactable: true,
        available: true,
        metadata: { login: 'octo-fixture', source: 'token' },
        usedBy: { extensions: [], commandAgents: [] },
        createdAt: now - 86_400_000,
        updatedAt: now - 86_400_000,
        lastUsedAt: now - 2 * 86_400_000,
      },
    ],
    modelProviders: [
      { provider: 'example-a', name: '示例供应商甲', open: true },
      { provider: 'example-b', name: '示例供应商乙', open: false },
    ],
    requests: [
      {
        ...request,
        agentId: targetAgentId,
        channelId: targetChannelId,
        createdAt: now - 10 * minute,
        route: credentialRequestRoute(request),
      },
    ],
    localGithubLogins: [{ login: 'octo-fixture', active: true }],
  })
}

export const weatherUses = (now = Date.now()): readonly CredentialUse[] => [
  {
    at: now - 5 * minute,
    agentId: targetAgentId,
    channelId: targetChannelId,
    requesterMemberId: null,
    consumerKind: 'extension',
    consumerId: summaryExtensionId,
    consumerName: productSnapshot.extensions[0]?.displayName ?? '示例扩展',
    targetHost: 'api.weather.example.com',
  },
  {
    at: now - 90 * minute,
    agentId: targetAgentId,
    channelId: null,
    requesterMemberId: null,
    consumerKind: 'command',
    consumerId: 'command',
    consumerName: null,
    targetHost: null,
  },
]
