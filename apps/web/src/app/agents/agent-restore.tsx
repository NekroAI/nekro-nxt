import { useEffect, useState } from 'react'
import type { AgentRevisionHistory } from '@nekro-nxt/contracts'
import { workspaceApi } from '../../host-api-client.js'
import type { AgentSummary } from '../../product-runtime.js'
import { Button, Dialog, Spinner, toast } from '../../ui-kit/index.js'
import { useProductApi } from '../model/store.js'
import styles from './agents.module.css'

type SavedConfig = AgentRevisionHistory['revisions'][number]

const FIELD_LABEL: Record<SavedConfig['changedFields'][number], string> = {
  name: '名称',
  persona: '设定',
  model: '模型',
  capabilities: '能力',
  imagePolicy: '图片理解',
  approvalPolicy: '运行确认',
}

/** `10月4日 14:20`, with the year when it is not this year. */
export const savedAt = (time: number, now = Date.now()): string => {
  const date = new Date(time)
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const day = `${date.getMonth() + 1}月${date.getDate()}日`
  return date.getFullYear() === new Date(now).getFullYear()
    ? `${day} ${clock}`
    : `${date.getFullYear()}年${day} ${clock}`
}

/** What a saved configuration changed compared with the one before it. */
export const changeSummary = (config: Pick<SavedConfig, 'changedFields'>, first: boolean): string =>
  first
    ? '创建时的配置'
    : config.changedFields.length > 0
      ? `改了${config.changedFields.map((field) => FIELD_LABEL[field]).join('、')}`
      : '内容与上一次相同'

/**
 * Earlier saved configurations of an agent, newest first. Restoring one makes it the current configuration again;
 * the user never sees the underlying revision identifiers.
 */
export function RestoreDialog({
  agent,
  open,
  onOpenChange,
  blocked,
}: {
  readonly agent: AgentSummary
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  /** Unsaved edits on the page; restoring would discard them, so it waits until they are saved or dropped. */
  readonly blocked: boolean
}) {
  const api = useProductApi()
  const [history, setHistory] = useState<AgentRevisionHistory>()
  const [error, setError] = useState('')
  const [restoring, setRestoring] = useState('')
  useEffect(() => {
    if (!open) return
    let live = true
    setError('')
    workspaceApi
      .listAgentRevisions(agent.id)
      .then((next) => live && setHistory(next))
      .catch((cause: unknown) => live && setError(cause instanceof Error ? cause.message : String(cause)))
    return () => {
      live = false
    }
  }, [agent.id, agent.currentRevisionId, open])

  const oldest = history?.revisions.at(-1)?.id
  const earlier = (history?.revisions.filter((config) => !config.current) ?? []).map((config) => ({
    config,
    summary: changeSummary(config, config.id === oldest),
    busy: restoring === config.id,
    locked: restoring !== '' && restoring !== config.id,
  }))
  const restore = async (config: SavedConfig) => {
    if (!history) return
    setRestoring(config.id)
    try {
      await workspaceApi.restoreAgentRevision(agent.id, config.id, history.currentRevisionId)
      await api.getState().refreshHost()
      toast(`已恢复 ${savedAt(config.createdAt)} 的配置`)
      onOpenChange(false)
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), { tone: 'bad' })
    } finally {
      setRestoring('')
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="恢复之前的配置"
      wide
      actions={<Button onClick={() => onOpenChange(false)}>关闭</Button>}
    >
      <p className={styles.note}>
        恢复后，{agent.name}的名称、设定、模型和能力回到当时的样子；进行中的对话在当前这一步结束后使用。
      </p>
      {blocked ? <p className={styles.noteWarn}>页面上还有未保存的修改，先保存或放弃后再恢复。</p> : null}
      {error ? <p className={styles.noteWarn}>{error}</p> : null}
      {!history && !error ? (
        <p className={styles.note}>
          <Spinner /> 正在读取
        </p>
      ) : null}
      {history && earlier.length === 0 ? <p className={styles.note}>还没有更早的配置。</p> : null}
      {earlier.length > 0 ? (
        <ol className={styles.restoreList}>
          {earlier.map(({ config, summary, busy, locked }) => (
            <li key={config.id} className={styles.restoreRow}>
              <span className={styles.cellStack}>
                <span className={styles.cellTitle}>{savedAt(config.createdAt)}</span>
                <span className={styles.cellSub}>
                  {summary} · {config.displayName} · {config.model.model}
                </span>
              </span>
              <Button size="small" busy={busy} disabled={blocked || locked} onClick={() => void restore(config)}>
                恢复
              </Button>
            </li>
          ))}
        </ol>
      ) : null}
    </Dialog>
  )
}
