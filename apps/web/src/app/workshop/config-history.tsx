import {
  configFields,
  HostApiContracts,
  type CredentialView,
  type ExtensionConfigVersion,
  type JsonValue,
} from '@nekro-nxt/contracts'
import { ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useCredentials } from '../../credentials/credentials-data.js'
import { activeConfigSchema } from '../../extension-ui/index.js'
import { callHostApi, StaleHostReadError } from '../../host-api-client.js'
import { useProductStore, type LocalExtensionSummary } from '../../product-runtime.js'
import { Button, ConfirmDialog, Disclosure, Pressable, toast } from '../../ui-kit/index.js'
import { savedAt } from '../agents/agent-restore.js'
import { useProductApi } from '../model/store.js'
import styles from './workshop.module.css'

/** Shown before the list grows longer; the rest opens on request. */
const FIRST_PAGE = 5

/**
 * Configuration history of one extension, all layers at once (newest first). Reloads whenever the stored
 * configuration changes, so a save on the page shows up as a new version.
 */
export function useConfigVersions(extension: LocalExtensionSummary) {
  const [versions, setVersions] = useState<readonly ExtensionConfigVersion[]>()
  const storedKey = JSON.stringify([
    extension.installation?.config,
    extension.installation?.boundCredentials,
    extension.installation?.configuredSecrets,
    extension.activations.map((activation) => [
      activation.config,
      activation.boundCredentials,
      activation.configuredSecrets,
    ]),
  ])
  const load = useCallback(async () => {
    try {
      const result = await callHostApi(
        HostApiContracts.getExtensionConfigVersions,
        { extensionId: extension.id },
        undefined,
      )
      setVersions(result.versions)
    } catch (cause) {
      if (!(cause instanceof StaleHostReadError)) setVersions([])
    }
  }, [extension.id])
  useEffect(() => {
    void load()
  }, [load, storedKey])
  return { versions, reload: load }
}

const asRecord = (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> =>
  value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value) ? value : {}

const shown = (value: JsonValue | undefined): string =>
  value === undefined || value === null ? '未设置' : typeof value === 'string' ? value : JSON.stringify(value)

/** A secret field as a version records it: the bound credential, set, or not set. */
const secretText = (
  version: ExtensionConfigVersion | undefined,
  key: string,
  credentials: readonly CredentialView[],
): string => {
  const bound = version?.boundCredentials?.[key]
  if (bound !== undefined) return credentials.find((credential) => credential.id === bound)?.name ?? '已删除的凭据'
  return version?.configuredSecrets?.includes(key) === true ? '已设置' : '未设置'
}

/** Fields that differ between a version and the one before it, as `title: old → new`. */
const changesOf = (
  version: ExtensionConfigVersion,
  previous: ExtensionConfigVersion | undefined,
  titles: ReadonlyMap<string, string>,
  secrets: ReadonlySet<string>,
  credentials: readonly CredentialView[],
) => {
  const before = asRecord(previous?.config)
  const after = asRecord(version.config)
  const keys = new Set([
    ...Object.keys(before),
    ...Object.keys(after),
    ...secrets,
    ...(version.configuredSecrets ?? []),
    ...(previous?.configuredSecrets ?? []),
    ...Object.keys(version.boundCredentials ?? {}),
    ...Object.keys(previous?.boundCredentials ?? {}),
  ])
  return [...keys].flatMap((key) => {
    const secret =
      secrets.has(key) || version.configuredSecrets?.includes(key) === true || version.boundCredentials?.[key]
    const from = secret ? secretText(previous, key, credentials) : shown(before[key])
    const to = secret ? secretText(version, key, credentials) : shown(after[key])
    return from === to ? [] : [{ key, title: titles.get(key) ?? key, from, to }]
  })
}

/**
 * History of one layer's configuration (the host's, or `agentId`'s) under its editor: when, who and why, what changed
 * against the version before, and a way back to any earlier version.
 */
export function ConfigHistory({
  extension,
  agentId,
  versions,
  onReverted,
}: {
  readonly extension: LocalExtensionSummary
  readonly agentId?: string | undefined
  readonly versions: readonly ExtensionConfigVersion[] | undefined
  readonly onReverted: () => Promise<void>
}) {
  const api = useProductApi()
  const agents = useProductStore((state) => state.agents)
  const { view } = useCredentials(versions !== undefined && versions.length > 0)
  const [expanded, setExpanded] = useState<number>()
  const [all, setAll] = useState(false)
  const [reverting, setReverting] = useState<ExtensionConfigVersion>()
  const layer = (versions ?? []).filter((version) =>
    agentId === undefined ? version.layer === 'host' : version.layer === 'agent' && version.agentId === agentId,
  )
  if (layer.length === 0) return null
  const schema = activeConfigSchema(extension, agentId)
  const fields = schema === undefined ? [] : configFields(schema)
  const titles = new Map(fields.map((field) => [field.key, field.title]))
  const secrets = new Set(fields.filter((field) => field.kind === 'secret').map((field) => field.key))
  const credentials = view?.credentials ?? []
  const agentName = (id: string | null) => agents.find((agent) => agent.id === id)?.name ?? '已删除的智能体'
  const sourceText = (version: ExtensionConfigVersion): string => {
    switch (version.source) {
      case 'console':
        return '后台'
      case 'agent':
        return `智能体「${agentName(version.actorAgentId)}」`
      case 'chat-admin':
        return '聊天中的管理员'
      case 'revert':
        return '恢复'
      case 'auto-revert':
        return '自动恢复'
    }
  }
  const listed = all ? layer : layer.slice(0, FIRST_PAGE)

  const revert = async () => {
    if (reverting === undefined) return
    await callHostApi(
      HostApiContracts.revertExtensionConfig,
      { extensionId: extension.id, versionId: String(reverting.id) },
      {},
    )
    await api.getState().refreshHost()
    await onReverted()
    toast('已恢复')
  }

  return (
    <section className={styles.configHistory} aria-label="配置历史">
      <h4 className={styles.configHistoryTitle}>配置历史</h4>
      <ol className={styles.configHistoryList}>
        {listed.map((version, index) => {
          const previous = layer[layer.indexOf(version) + 1]
          const open = expanded === version.id
          const changes = changesOf(version, previous, titles, secrets, credentials)
          return (
            <li key={version.id} className={styles.configHistoryItem}>
              <div className={styles.configHistoryRow}>
                <Pressable
                  className={styles.configHistoryToggle}
                  aria-expanded={open}
                  onClick={() => setExpanded(open ? undefined : version.id)}
                >
                  <ChevronRight size={14} aria-hidden="true" data-open={open} />
                  <span>{savedAt(version.createdAt)}</span>
                  <span className={styles.configHistorySource}>{sourceText(version)}</span>
                  {index === 0 ? <span className={styles.configHistoryCurrent}>当前</span> : null}
                </Pressable>
                {index === 0 ? null : (
                  <Button size="small" variant="ghost" onClick={() => setReverting(version)}>
                    恢复到这一版
                  </Button>
                )}
              </div>
              {version.reason ? <p className={styles.configHistoryReason}>{version.reason}</p> : null}
              <Disclosure open={open}>
                {changes.length === 0 ? (
                  <p className={styles.configHistoryReason}>与上一版相同</p>
                ) : (
                  <dl className={styles.configHistoryDiff}>
                    {changes.map((change) => (
                      <div key={change.key}>
                        <dt>{change.title}</dt>
                        <dd>
                          <span className={styles.configHistoryOld}>{change.from}</span>
                          {' → '}
                          <span>{change.to}</span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </Disclosure>
            </li>
          )
        })}
      </ol>
      {!all && layer.length > FIRST_PAGE ? (
        <Button size="small" variant="ghost" onClick={() => setAll(true)}>
          显示更早的 {layer.length - FIRST_PAGE} 版
        </Button>
      ) : null}
      <ConfirmDialog
        open={reverting !== undefined}
        onOpenChange={(open) => !open && setReverting(undefined)}
        title="恢复到这一版？"
        confirmLabel="恢复"
        onConfirm={revert}
      >
        {reverting === undefined ? null : <p>{savedAt(reverting.createdAt)} 的配置会保存为最新的一版。</p>}
      </ConfirmDialog>
    </section>
  )
}
