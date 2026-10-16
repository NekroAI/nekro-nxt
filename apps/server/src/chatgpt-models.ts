import type { Context } from '@deepseek-ai/cordis'
import { resolveRetryPolicy, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter, type ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { createProvider, InMemoryCredentialStore, hasApi, type Model } from '@earendil-works/pi-ai'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import * as responses from '@earendil-works/pi-ai/api/openai-responses'
import { z } from 'zod'
import { ChatGptAuth, CHATGPT_RESOURCE } from './chatgpt-auth.js'
import type { HostLogSink } from './logs/service.js'

export const CHATGPT_PROVIDER = 'chatgpt'
const owners = new WeakMap<Context, ChatGptAuth>()
export const chatGptAuth = (context: Context): ChatGptAuth | undefined => owners.get(context)

const requireCompleted = (event: unknown): void => {
  if (event !== null && typeof event === 'object' && Reflect.get(event, 'type') === 'response.incomplete')
    throw new Error('ChatGPT 未完成本次请求，请重试。')
}

/** The preview route accepts a smaller Responses vocabulary than API-key inference. */
export function chatGptPayload(payload: unknown): Record<string, unknown> {
  const body = z.record(z.string(), z.unknown()).parse(payload)
  for (const field of [
    'background',
    'conversation',
    'max_output_tokens',
    'max_tool_calls',
    'metadata',
    'moderation',
    'multi_agent',
    'prompt',
    'prompt_cache_retention',
    'safety_identifier',
    'temperature',
    'top_logprobs',
    'top_p',
    'truncation',
    'user',
    'previous_response_id',
  ])
    delete body[field]
  body['store'] = false
  body['stream'] = true
  if (Array.isArray(body['input'])) {
    body['input'] = body['input'].map((item: unknown) => {
      const entry = z.record(z.string(), z.unknown()).parse(item)
      if (entry['type'] === 'function_call' || entry['type'] === 'custom_tool_call')
        return { ...entry, namespace: 'nekro_nxt' }
      return entry['role'] === 'system' ? { ...entry, role: 'developer' } : entry
    })
  }
  if (Array.isArray(body['tools']) && body['tools'].length) {
    body['tools'] = [{ type: 'namespace', name: 'nekro_nxt', description: 'NekroNXT tools', tools: body['tools'] }]
  }
  return body
}

/** Reuses the public DSH adapter for messages, images, tool calls, replay and stream validation. */
export function createChatGptAdapter(auth: ChatGptAuth, context?: Context): PiAiAdapter {
  const base = openaiProvider()
  const catalog = base.getModels()
  let lastId: string | null | undefined
  let lastModels: ReturnType<ChatGptAuth['view']>['models'] | undefined
  let profiles = new Map<string, ResolvedPiAiProviderProfile>()
  const profileAccounts = new WeakMap<ResolvedPiAiProviderProfile, string>()
  return new PiAiAdapter({
    profiles: () => {
      const state = auth.view()
      if (state.activeId === lastId && state.models === lastModels) return profiles
      lastId = state.activeId
      lastModels = state.models
      profiles = new Map()
      const models: Model<'openai-responses'>[] = state.models.map((item) => {
        const known = catalog.find((model) => model.id === item.id)
        return {
          ...(known ?? {
            reasoning: false,
            contextWindow: 128_000,
            maxTokens: 32_768,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          }),
          ...item,
          api: 'openai-responses',
          provider: CHATGPT_PROVIDER,
          baseUrl: CHATGPT_RESOURCE,
        }
      })
      const profile: ResolvedPiAiProviderProfile = {
        provider: CHATGPT_PROVIDER,
        displayName: 'ChatGPT',
        api: 'openai-responses',
        baseURL: CHATGPT_RESOURCE,
        streamIdleTimeoutMs: 120_000,
        maxRequestImageBytes: 20 * 1024 * 1024,
        requestImagePixelBudget: 4_000_000,
        requestImageMaxBytes: 4 * 1024 * 1024,
        retryPolicy: resolveRetryPolicy(undefined, 'chatgpt'),
        modelErrors: new Map(),
        configuredMaxTokens: new Map(),
        piProvider: createProvider({
          id: CHATGPT_PROVIDER,
          name: 'ChatGPT',
          models,
          auth: base.auth,
          api: {
            stream: (model, history, options) => {
              if (!hasApi(model, 'openai-responses')) throw new Error('Invalid ChatGPT protocol.')
              return responses.stream(model, history, {
                ...options,
                onPayload: chatGptPayload,
                onProviderStreamEvent: requireCompleted,
              })
            },
            streamSimple: (model, history, options) => {
              if (!hasApi(model, 'openai-responses')) throw new Error('Invalid ChatGPT protocol.')
              return responses.streamSimple(model, history, {
                ...options,
                onPayload: chatGptPayload,
                onProviderStreamEvent: requireCompleted,
              })
            },
          },
        }),
      }
      if (state.activeId) profileAccounts.set(profile, state.activeId)
      profiles.set(CHATGPT_PROVIDER, profile)
      return profiles
    },
    resolveApiKey: (_provider, profile) => {
      const id = profileAccounts.get(profile)
      if (!id) throw new Error('请先登录 ChatGPT。')
      return auth.accessToken(id)
    },
    auth: {
      credentials: new InMemoryCredentialStore(),
      authContext: { env: () => Promise.resolve(undefined), fileExists: () => Promise.resolve(false) },
    },
    ...(context
      ? {
          resolveAttachments: () => context.get('attachments'),
          resolveImageAccess: (attachments, ref) =>
            resolveImageAttachmentAccess(
              attachments,
              (hostPath) => context.get('fs')?.processPathFromHostPath(hostPath),
              ref,
            ),
        }
      : {}),
  })
}

export const name = 'nxt-chatgpt'
export const inject = ['llm']
export async function apply(context: Context, options: { root: string; logs?: HostLogSink }): Promise<void> {
  const auth = await ChatGptAuth.open(options.root, { onSecret: (value) => options.logs?.registerSecret?.(value) })
  owners.set(context.root, auth)
  const unregister = context.llm.registerAdapter([CHATGPT_PROVIDER], createChatGptAdapter(auth, context))
  context.effect(() => async () => {
    unregister()
    await auth.dispose()
    owners.delete(context.root)
  })
}
