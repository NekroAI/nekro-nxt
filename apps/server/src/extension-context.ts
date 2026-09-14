import type { Context } from '@deepseek-ai/cordis'
const EXTENSION_PRIVATE_SERVICE_KEYS = [
  'agentPresets',
  'agents',
  'attachments',
  'compaction',
  'llm',
  'sandbox',
  'sandboxPolicy',
  'sessionProjections',
  'sessionPersistence',
  'sessions',
  'shell',
  'shellEnv',
  'skills',
  'subprocess',
  'subagents',
  'spillStore',
  'tokenMeter',
  'toolResultPruner',
  'web',
] as const
export const EXTENSION_PRIVATE_SERVICE_KEY_SET = new Set<string>(EXTENSION_PRIVATE_SERVICE_KEYS)

export const isolatePrivateExtensionServices = (context: Context): Context =>
  EXTENSION_PRIVATE_SERVICE_KEYS.reduce((isolated, key) => isolated.isolate(key), context)
