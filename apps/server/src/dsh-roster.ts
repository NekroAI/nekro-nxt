import { expectedDshPackageVersion } from '@nekro-nxt/dsh-compat/release'
import { z } from 'zod'

const HOST_DSH_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/dsh-atomic-write',
  '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-attachment-local',
  '@deepseek-ai/dsh-bash-sandbox',
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-compaction-tool-result-pruner',
  '@deepseek-ai/dsh-config-editor',
  '@deepseek-ai/dsh-cordis-host-runner',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-credentials-local',
  '@deepseek-ai/dsh-fs-observation-policy',
  '@deepseek-ai/dsh-fs-sandbox',
  '@deepseek-ai/dsh-host-frontend-static',
  '@deepseek-ai/dsh-host-plugin-inventory',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-launch-environment',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-llm-deepseek-api-key',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-llm-retry',
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-mcp-resources',
  '@deepseek-ai/dsh-output-retention',
  '@deepseek-ai/dsh-ptc-runtime-node',
  '@deepseek-ai/dsh-sandbox-local',
  '@deepseek-ai/dsh-sandbox-policy',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-checkpoint-policy',
  '@deepseek-ai/dsh-session-persistence',
  '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-session-query',
  '@deepseek-ai/dsh-session-query-sqlite',
  '@deepseek-ai/dsh-session-stats',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-shell-env',
  '@deepseek-ai/dsh-skill',
  '@deepseek-ai/dsh-spill',
  '@deepseek-ai/dsh-spill-local',
  '@deepseek-ai/dsh-spill-policy',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-subagent-spawn-in-process',
  '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-token-meter',
  '@deepseek-ai/dsh-tool-bash',
  '@deepseek-ai/dsh-tool-call-timeout-policy',
  '@deepseek-ai/dsh-tool-cordis',
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-tool-skill',
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-tool-subagent-control',
  '@deepseek-ai/dsh-tool-web',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-util-values',
  '@deepseek-ai/dsh-web',
  '@deepseek-ai/dsh-web-search-deepseek',
  '@deepseek-ai/dsh-working-directory',
] as const

export const HOST_DSH_PACKAGE_VERSIONS = z.record(z.enum(HOST_DSH_PACKAGES), z.string()).parse(
  Object.fromEntries(
    HOST_DSH_PACKAGES.map((name) => {
      const version = expectedDshPackageVersion(name)
      if (version === undefined) throw new Error(`DSH release manifest is missing Host package: ${name}`)
      return [name, version]
    }),
  ),
)

interface DshBuiltinExtensionEntry {
  readonly packageName: keyof typeof HOST_DSH_PACKAGE_VERSIONS
  readonly settingsNamespaces?: readonly string[]
}

export const DSH_BUILTIN_EXTENSION_ROSTER: readonly DshBuiltinExtensionEntry[] = [
  {
    packageName: '@deepseek-ai/dsh-llm-pi-ai',
    settingsNamespaces: ['llm-pi-ai'],
  },
  {
    packageName: '@deepseek-ai/dsh-llm-deepseek-api-key',
    settingsNamespaces: ['llm-deepseek'],
  },
  {
    packageName: '@deepseek-ai/dsh-agent-loop',
    settingsNamespaces: ['agent-loop'],
  },
  {
    packageName: '@deepseek-ai/dsh-bash-sandbox',
    settingsNamespaces: ['shell'],
  },
  {
    packageName: '@deepseek-ai/dsh-subagent',
    settingsNamespaces: ['subagent'],
  },
  {
    packageName: '@deepseek-ai/dsh-subagent-spawn-in-process',
  },
  {
    packageName: '@deepseek-ai/dsh-tool-subagent',
  },
  {
    packageName: '@deepseek-ai/dsh-tool-subagent-control',
  },
  {
    packageName: '@deepseek-ai/dsh-web',
  },
  {
    packageName: '@deepseek-ai/dsh-web-search-deepseek',
    settingsNamespaces: ['web-search-deepseek'],
  },
  {
    packageName: '@deepseek-ai/dsh-tool-web',
  },
  {
    packageName: '@deepseek-ai/dsh-compaction-tool-result-pruner',
  },
  {
    packageName: '@deepseek-ai/dsh-llm-retry',
  },
  {
    packageName: '@deepseek-ai/dsh-tool-call-timeout-policy',
  },
  {
    packageName: '@deepseek-ai/dsh-spill-policy',
    settingsNamespaces: ['spill-policy'],
  },
  {
    packageName: '@deepseek-ai/dsh-cordis-host-runner',
  },
] as const

export const DSH_SETTINGS_OWNER = new Map(
  DSH_BUILTIN_EXTENSION_ROSTER.flatMap((entry) =>
    (entry.settingsNamespaces ?? []).map((ns) => [ns, entry.packageName] as const),
  ),
)
