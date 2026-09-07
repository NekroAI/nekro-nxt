export const HOST_DSH_PACKAGE_VERSIONS = {
  '@deepseek-ai/cordis': '4.0.1',
  '@deepseek-ai/dsh-agent': '0.1.1-rc.2',
  '@deepseek-ai/dsh-agent-loop': '0.1.1-rc.2',
  '@deepseek-ai/dsh-attachment': '0.1.1-rc.2',
  '@deepseek-ai/dsh-attachment-local': '0.1.1-rc.2',
  '@deepseek-ai/dsh-bash-sandbox': '0.1.1-rc.2',
  '@deepseek-ai/dsh-compaction-basic': '0.1.1-rc.2',
  '@deepseek-ai/dsh-compaction-tool-result-pruner': '0.1.1-rc.2',
  '@deepseek-ai/dsh-cordis-host-runner': '0.1.1-rc.2',
  '@deepseek-ai/dsh-credentials': '0.1.1-rc.2',
  '@deepseek-ai/dsh-credentials-local': '0.1.1-rc.2',
  '@deepseek-ai/dsh-launch-environment': '0.1.1-rc.2',
  '@deepseek-ai/dsh-llm': '0.1.1-rc.2',
  '@deepseek-ai/dsh-llm-deepseek': '0.1.1-rc.2',
  '@deepseek-ai/dsh-llm-pi-ai': '0.1.1-rc.2',
  '@deepseek-ai/dsh-llm-retry': '0.1.1-rc.2',
  '@deepseek-ai/dsh-output-retention': '0.1.1-rc.2',
  '@deepseek-ai/dsh-fs-observation-policy': '0.1.1-rc.2',
  '@deepseek-ai/dsh-fs-sandbox': '0.1.1-rc.2',
  '@deepseek-ai/dsh-sandbox-local': '0.1.1-rc.2',
  '@deepseek-ai/dsh-sandbox-policy': '0.1.1-rc.2',
  '@deepseek-ai/dsh-scope': '0.1.1-rc.2',
  '@deepseek-ai/dsh-session': '0.1.1-rc.2',
  '@deepseek-ai/dsh-session-checkpoint-policy': '0.1.1-rc.2',
  '@deepseek-ai/dsh-session-persistence-sqlite': '0.1.1-rc.2',
  '@deepseek-ai/dsh-session-projection': '0.1.1-rc.2',
  '@deepseek-ai/dsh-session-stats': '0.1.1-rc.2',
  '@deepseek-ai/dsh-settings': '0.1.1-rc.2',
  '@deepseek-ai/dsh-settings-file': '0.1.1-rc.2',
  '@deepseek-ai/dsh-skill': '0.1.1-rc.2',
  '@deepseek-ai/dsh-system-prompt': '0.1.1-rc.2',
  '@deepseek-ai/dsh-shell-env': '0.1.1-rc.2',
  '@deepseek-ai/dsh-subprocess-local': '0.1.1-rc.2',
  '@deepseek-ai/dsh-token-meter': '0.1.1-rc.2',
  '@deepseek-ai/dsh-spill': '0.1.1-rc.2',
  '@deepseek-ai/dsh-spill-local': '0.1.1-rc.2',
  '@deepseek-ai/dsh-spill-policy': '0.1.1-rc.2',
  '@deepseek-ai/dsh-subagent': '0.1.1-rc.2',
  '@deepseek-ai/dsh-subagent-spawn-in-process': '0.1.1-rc.2',
  '@deepseek-ai/dsh-tool-bash': '0.1.1-rc.2',
  '@deepseek-ai/dsh-tool-call-timeout-policy': '0.1.1-rc.2',
  '@deepseek-ai/dsh-tool-cordis': '0.1.1-rc.2',
  '@deepseek-ai/dsh-tool-fs': '0.1.1-rc.2',
  '@deepseek-ai/dsh-tool-skill': '0.1.1-rc.2',
  '@deepseek-ai/dsh-tool-subagent': '0.1.1-rc.2',
  '@deepseek-ai/dsh-tool-subagent-control': '0.1.1-rc.2',
  '@deepseek-ai/dsh-tool-subagent-report': '0.1.1-rc.2',
  '@deepseek-ai/dsh-tool-web': '0.1.1-rc.2',
  '@deepseek-ai/dsh-tools': '0.1.1-rc.2',
  '@deepseek-ai/dsh-web': '0.1.1-rc.2',
  '@deepseek-ai/dsh-web-search-deepseek': '0.1.1-rc.2',
} as const

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
    packageName: '@deepseek-ai/dsh-llm-deepseek',
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
