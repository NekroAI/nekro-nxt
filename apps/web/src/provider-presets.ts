/** A relay the product recommends: pre-fills the custom route and knows which of its models are for chat. */
export interface ProviderPreset {
  /** Selection value in the add-provider dialog; never a provider key. */
  readonly key: string
  readonly label: string
  readonly baseURL: string
  /** API protocol the route is created with. */
  readonly api: string
  /** Where to get a key. */
  readonly keyUrl: string
  /** Whether the dialog marks it as recommended. */
  readonly recommended: boolean
  /** Which of the relay's models this entry offers after "获取可用模型". */
  readonly offers: (modelId: string) => boolean
}

/** Image generation, speech, embedding and rerank models the relay lists next to chat models. */
const NON_CHAT_MODEL =
  /image|imagine|seedream|banana|dall-?e|flux|midjourney|stable-diffusion|sdxl|sora|veo|embed|rerank|bge-|\btts\b|-tts|whisper|transcribe|moderation/iu

/** Whether a relay model can hold a conversation; the relay mixes every kind of model into one list. */
export const isChatModelId = (id: string): boolean => !NON_CHAT_MODEL.test(id)

const isClaudeModelId = (id: string): boolean => /^claude/iu.test(id)

/**
 * Ordered as shown: the first entry leads the dialog. Claude has its own entry because only the Anthropic protocol
 * lets prompt caching hit; through the OpenAI-compatible route the relay never caches Claude prompts.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    key: '__preset:nekro-api__',
    label: 'NekroAPI',
    baseURL: 'https://api.nekro.ai/v1',
    api: 'openai-completions',
    keyUrl: 'https://api.nekro.ai',
    recommended: true,
    offers: (id) => isChatModelId(id) && !isClaudeModelId(id),
  },
  {
    key: '__preset:nekro-api-claude__',
    label: 'NekroAPI · Claude',
    baseURL: 'https://api.nekro.ai',
    api: 'anthropic-messages',
    keyUrl: 'https://api.nekro.ai',
    recommended: false,
    // The relay also lists "-nocache" twins of Claude models; this route caches, so the twins add nothing.
    offers: (id) => isClaudeModelId(id) && isChatModelId(id) && !/-nocache$/iu.test(id),
  },
]

export const presetByKey = (key: string): ProviderPreset | undefined =>
  PROVIDER_PRESETS.find((preset) => preset.key === key)

const normalizedAddress = (baseURL: string): string => baseURL.trim().replace(/\/+$/u, '').toLowerCase()

/** The preset an API address belongs to, so its key link and model filter follow a saved route as well. */
export const presetForBaseURL = (baseURL: string | undefined): ProviderPreset | undefined =>
  baseURL
    ? PROVIDER_PRESETS.find((preset) => normalizedAddress(preset.baseURL) === normalizedAddress(baseURL))
    : undefined
