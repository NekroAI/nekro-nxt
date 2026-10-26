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

// Installed DSH plugins extend the public DSH runtime itself. They may consume the
// host-owned SkillRegistry, while NXT-authored extensions keep the stricter boundary below.
const MANAGED_DSH_PRIVATE_SERVICE_KEYS = EXTENSION_PRIVATE_SERVICE_KEYS.filter((key) => key !== 'skills')

export const isolatePrivateExtensionServices = (context: Context): Context =>
  EXTENSION_PRIVATE_SERVICE_KEYS.reduce((isolated, key) => isolated.isolate(key), context)

export const isolateManagedDshPluginServices = (context: Context): Context =>
  MANAGED_DSH_PRIVATE_SERVICE_KEYS.reduce((isolated, key) => isolated.isolate(key), context)
