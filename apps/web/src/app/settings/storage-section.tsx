import { useEffect, useState } from 'react'
import type { UpgradeBackupSettings } from '@nekro-nxt/contracts'
import {
  describeDataMoveProblem,
  desktopStorageBridge,
  formatBytes,
  formatDuration,
  type DesktopDataDirectoryChoice,
  type DesktopDataDirectoryStatus,
  type DesktopStorageBridge,
} from '../../desktop-storage.js'
import { workspaceApi } from '../../host-api-client.js'
import { Button, ConfirmDialog, Input, PropertyList, PropertyRow, Select, toast } from '../../ui-kit/index.js'
import { SectionHead } from './section-head.js'
import styles from './settings.module.css'

const failure = (error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })

/** Where this instance keeps its data and its upgrade recovery points. */
export function StorageSection() {
  return (
    <>
      <SectionHead title="存储" />
      <PropertyList>
        <DataDirectoryRows />
        <UpgradeBackupRows />
      </PropertyList>
    </>
  )
}

type ReadyChoice = Extract<DesktopDataDirectoryChoice, { kind: 'ready' }>

/** The Desktop local instance's data directory: where it is, how big, and moving it. Hidden everywhere else. */
function DataDirectoryRows() {
  const [bridge] = useState<DesktopStorageBridge | undefined>(desktopStorageBridge)
  const [status, setStatus] = useState<DesktopDataDirectoryStatus>()
  const [sizes, setSizes] = useState<{ readonly current: number; readonly oldDirectory?: number }>()
  const [choosing, setChoosing] = useState(false)
  const [plan, setPlan] = useState<ReadyChoice>()
  const load = async (target: DesktopStorageBridge) => {
    const result = await target.status()
    if (!result.supported) return
    setStatus(result.status)
    setSizes(await target.sizes())
  }
  useEffect(() => {
    if (bridge !== undefined) void load(bridge).catch(() => undefined)
  }, [bridge])
  if (bridge === undefined || status === undefined) return null

  const choose = async () => {
    setChoosing(true)
    try {
      const choice = await bridge.chooseDirectory()
      if (choice.kind === 'rejected') toast(describeDataMoveProblem(choice.problem), { tone: 'bad' })
      if (choice.kind === 'ready') setPlan(choice)
    } catch (error) {
      failure(error)
    } finally {
      setChoosing(false)
    }
  }
  const start = async (target: string) => {
    const result = await bridge.startMove(target)
    // On success the app restarts into the move; a target that stopped qualifying comes back as a rejection.
    if (result.kind === 'rejected') throw new Error(describeDataMoveProblem(result.problem))
  }
  const dismiss = async () => {
    try {
      await bridge.dismissNotice()
      await load(bridge)
    } catch (error) {
      failure(error)
    }
  }
  const locked = status.lockedBy === 'environment'
  const old = status.oldDirectory
  return (
    <>
      <PropertyRow
        label="数据目录"
        layout="stacked"
        description={
          <>
            <span className={styles.path} data-testid="data-directory-path">
              {status.path}
            </span>
            <span>
              {locked
                ? '数据目录由环境变量指定'
                : sizes === undefined
                  ? '正在计算占用'
                  : `占用 ${formatBytes(sizes.current)}`}
            </span>
          </>
        }
      >
        <Button size="small" busy={choosing} disabled={locked} onClick={() => void choose()}>
          更改
        </Button>
      </PropertyRow>
      {old === undefined ? null : (
        <PropertyRow
          label="旧目录"
          layout="stacked"
          description={
            <>
              <span className={styles.path}>{old.path}</span>
              <span>
                {sizes?.oldDirectory === undefined ? '' : `${formatBytes(sizes.oldDirectory)} · `}
                {old.method === 'copy'
                  ? '原来的数据还在这里。确认新目录正常后，可以手动删除。'
                  : '这里只剩之前的升级恢复点，它们不能用于新目录。'}
              </span>
            </>
          }
        >
          <div className={styles.actions}>
            <Button size="small" onClick={() => void bridge.revealOldDirectory().catch(failure)}>
              在文件夹中显示
            </Button>
            <Button size="small" variant="ghost" onClick={() => void dismiss()}>
              我已删除，不再提示
            </Button>
          </div>
        </PropertyRow>
      )}
      {status.lastFailure === undefined ? null : (
        <PropertyRow
          label="上次更改"
          layout="stacked"
          description={
            <span className={styles.noteWarn}>
              没有更改到 {status.lastFailure.target}：
              {status.lastFailure.file === undefined ? '' : `${status.lastFailure.file}，`}
              {status.lastFailure.message}
            </span>
          }
        >
          <Button size="small" variant="ghost" onClick={() => void dismiss()}>
            不再提示
          </Button>
        </PropertyRow>
      )}
      <ConfirmDialog
        open={plan !== undefined}
        onOpenChange={(open) => {
          if (!open) setPlan(undefined)
        }}
        title="更改数据目录"
        confirmLabel="开始迁移"
        onConfirm={async () => {
          if (plan !== undefined) await start(plan.target)
        }}
      >
        {plan === undefined ? null : (
          <dl className={styles.movePlan}>
            <dt>新目录</dt>
            <dd className={styles.path}>{plan.target}</dd>
            <dt>方式</dt>
            <dd>{plan.method === 'move' ? '同一磁盘内移动' : '复制到新位置并校验，原目录保留'}</dd>
            <dt>大小</dt>
            <dd>{formatBytes(plan.bytes)}</dd>
            <dt>预计时间</dt>
            <dd>{formatDuration(plan.estimatedSeconds)}</dd>
          </dl>
        )}
        <p className={styles.notice}>迁移期间应用会重启，本机实例暂停。升级恢复点留在原目录，不能用于新目录。</p>
      </ConfirmDialog>
    </>
  )
}

const gigabytes = (bytes: number) => `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`

const BACKUP_MODES = [
  { value: 'data', label: '保存在数据目录' },
  { value: 'directory', label: '保存到其他位置' },
  { value: 'off', label: '不备份' },
] as const

/** Restore points taken before an upgrade: where they go, or none. */
function UpgradeBackupRows() {
  const [settings, setSettings] = useState<UpgradeBackupSettings>()
  const [mode, setMode] = useState<UpgradeBackupSettings['mode']>('data')
  const [directory, setDirectory] = useState('')
  const [busy, setBusy] = useState(false)
  const apply = (next: UpgradeBackupSettings) => {
    setSettings(next)
    setMode(next.mode)
    setDirectory(next.directory ?? '')
  }
  useEffect(() => {
    const controller = new AbortController()
    workspaceApi
      .getUpgradeBackupSettings({ signal: controller.signal })
      .then(apply)
      .catch(() => undefined)
    return () => controller.abort()
  }, [])
  if (settings === undefined) return null
  const save = async (next: UpgradeBackupSettings['mode'], path?: string) => {
    setBusy(true)
    try {
      apply(
        await workspaceApi.updateUpgradeBackupSettings({
          mode: next,
          ...(next === 'directory' && path ? { directory: path.trim() } : {}),
        }),
      )
      toast('已保存')
    } catch (error) {
      failure(error)
    } finally {
      setBusy(false)
    }
  }
  const usage =
    settings.mode === 'off'
      ? '升级时不备份'
      : settings.usage.count === 0
        ? `升级前备份全部数据，保留最近 ${settings.keep} 份`
        : `已保留 ${settings.usage.count} 份，共 ${gigabytes(settings.usage.bytes)}；保留最近 ${settings.keep} 份`
  return (
    <>
      <PropertyRow label="升级前备份" description={settings.locked ? '由服务端环境变量设置' : usage}>
        <Select
          aria-label="升级前备份"
          value={mode}
          disabled={settings.locked || busy}
          options={BACKUP_MODES.map((option) => ({ ...option }))}
          onValueChange={(value) => {
            const next = BACKUP_MODES.find((option) => option.value === value)?.value
            if (next === undefined) return
            setMode(next)
            if (next !== 'directory') void save(next)
          }}
        />
      </PropertyRow>
      {mode === 'directory' ? (
        <PropertyRow label="备份位置" description="例如外置盘上的目录；已有的备份留在原位置">
          <div className={styles.inlineForm}>
            <Input
              value={directory}
              spellCheck={false}
              disabled={settings.locked}
              placeholder="/mnt/nekro-nxt-backups"
              aria-label="备份位置"
              onChange={(event) => setDirectory(event.target.value)}
            />
            {settings.locked ? null : (
              <Button
                size="small"
                busy={busy}
                disabled={!directory.trim() || (settings.mode === 'directory' && directory === settings.directory)}
                onClick={() => void save('directory', directory)}
              >
                保存
              </Button>
            )}
          </div>
        </PropertyRow>
      ) : null}
    </>
  )
}
