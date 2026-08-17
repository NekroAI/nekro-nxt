const providerLabels: Readonly<Record<string, string>> = {
  'amazon-bedrock': 'Amazon Bedrock',
  'ant-ling': 'Ant Ling',
  anthropic: 'Anthropic',
  'azure-openai-responses': 'Azure OpenAI Responses',
  cerebras: 'Cerebras',
  'cloudflare-ai-gateway': 'Cloudflare AI Gateway',
  'cloudflare-workers-ai': 'Cloudflare Workers AI',
  deepseek: 'DeepSeek',
  fireworks: 'Fireworks AI',
  'github-copilot': 'GitHub Copilot',
  google: 'Google AI',
  'google-vertex': 'Google Vertex AI',
  groq: 'Groq',
  huggingface: 'Hugging Face',
  'kimi-coding': 'Kimi Coding',
  minimax: 'MiniMax',
  'minimax-cn': 'MiniMax（中国）',
  mistral: 'Mistral AI',
  moonshotai: 'Moonshot AI',
  'moonshotai-cn': 'Moonshot AI（中国）',
  nvidia: 'NVIDIA',
  openai: 'OpenAI',
  opencode: 'OpenCode',
  'opencode-go': 'OpenCode Go',
  openrouter: 'OpenRouter',
  'qwen-token-plan': 'Qwen Token Plan',
  'qwen-token-plan-cn': 'Qwen Token Plan（中国）',
  together: 'Together AI',
  'vercel-ai-gateway': 'Vercel AI Gateway',
  xai: 'xAI',
  xiaomi: 'Xiaomi',
  'xiaomi-token-plan-ams': 'Xiaomi Token Plan（阿姆斯特丹）',
  'xiaomi-token-plan-cn': 'Xiaomi Token Plan（中国）',
  'xiaomi-token-plan-sgp': 'Xiaomi Token Plan（新加坡）',
  zai: 'Z.AI',
  'zai-coding-cn': 'Z.AI Coding（中国）',
}

const titleToken = (token: string): string => {
  const lower = token.toLowerCase()
  if (lower === 'ai') return 'AI'
  if (lower === 'api') return 'API'
  if (lower === 'cn') return 'CN'
  return token.charAt(0).toUpperCase() + token.slice(1)
}

const readableFallback = (value: string): string =>
  value
    .trim()
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map(titleToken)
    .join(' ')

/** Keeps the DSH provider directory authoritative while projecting product-quality labels. */
export const providerDisplayName = (provider: string, upstreamName?: string): string => {
  const providerKey = provider.trim().toLowerCase()
  const upstream = upstreamName?.trim() ?? ''
  if (upstream && upstream.toLowerCase() !== providerKey) return upstream
  return (providerLabels[providerKey] ?? readableFallback(upstream || provider)) || '未命名模型供应商'
}
