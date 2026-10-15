import { HostApiContracts, type HostApiResponse } from '@nekro-nxt/contracts'
import { Archive, Download, FolderInput, MoreHorizontal, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { callHostApi } from '../../host-api-client.js'
import { useProductStore, type LocalExtensionSummary } from '../../product-runtime.js'
import {
  Banner,
  Button,
  Dialog,
  Field,
  FileChooser,
  Input,
  Menu,
  PropertyGroup,
  Segmented,
  Select,
  Skeleton,
  SwitchRow,
  toast,
} from '../../ui-kit/index.js'
import { relativeTime } from '../channels/timeline-model.js'
import styles from './lineage.module.css'

type DataState = HostApiResponse<'getExtensionData'>
type Preview = HostApiResponse<'previewExtensionDataMigration'>
type Inspection = HostApiResponse<'inspectExtensionDataPackage'>

/** Where migrated data comes from, with the words the dialog uses for it. */
export type MigrationSource =
  | { readonly kind: 'extension'; readonly extensionId: string; readonly name: string }
  | { readonly kind: 'snapshot'; readonly snapshotId: string; readonly name: string }
  | { readonly kind: 'package'; readonly inspection: Inspection }

const failure = (error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })

const SNAPSHOT_REASON: Record<DataState['snapshots'][number]['reason'], string> = {
  switch: '切换版本前',
  migration: '迁移数据前',
  manual: '手动',
}

const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`

const saveBytes = (bytes: Uint8Array, filename: string) => {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/zip' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * What the extension has stored on this machine: how much, in which data format, the copies kept before switches and
 * migrations, and the ways to move data in and out.
 */
export function ExtensionData({ extension }: { readonly extension: LocalExtensionSummary }) {
  const extensions = useProductStore((state) => state.extensions)
  const [state, setState] = useState<DataState>()
  const [source, setSource] = useState<MigrationSource>()
  const [choosing, setChoosing] = useState(false)
  const chooser = useRef<HTMLInputElement>(null)
  const load = () =>
    callHostApi(HostApiContracts.getExtensionData, { extensionId: extension.id }, undefined)
      .then(setState)
      .catch(() => setState(undefined))
  useEffect(() => {
    void load()
  }, [extension.id, extension.dataVersion, extension.installation?.revisionId])

  const exportData = async (withConfig: boolean) => {
    try {
      const bytes = await callHostApi(
        withConfig ? HostApiContracts.exportExtensionDataWithConfig : HostApiContracts.exportExtensionData,
        { extensionId: extension.id },
        undefined,
      )
      saveBytes(bytes, `${extension.slug}-data.nxt-extension-data`)
    } catch (error) {
      failure(error)
    }
  }
  const snapshot = async () => {
    try {
      await callHostApi(
        HostApiContracts.createExtensionDataSnapshot,
        { extensionId: extension.id },
        { label: `手动快照 ${new Date().toLocaleString()}` },
      )
      toast('已留一份快照')
      await load()
    } catch (error) {
      failure(error)
    }
  }
  const inspect = async (file: File) => {
    try {
      const inspection = await callHostApi(
        HostApiContracts.inspectExtensionDataPackage,
        {},
        { bytes: new Uint8Array(await file.arrayBuffer()), fileName: file.name },
      )
      setSource({ kind: 'package', inspection })
    } catch (error) {
      failure(error)
    }
  }

  const others = extensions.filter((item) => item.id !== extension.id)
  return (
    <PropertyGroup
      title="数据"
      tip="扩展在本机积累的记录、检索索引和素材。切换版本和迁移前都会自动留一份快照。"
      actions={
        <Menu
          label="数据操作"
          align="end"
          trigger={
            <Button size="small" variant="ghost" icon={<MoreHorizontal size={14} />}>
              迁移与导出
            </Button>
          }
          items={[
            { key: 'snapshot', label: '留一份快照', icon: <Archive size={14} />, onSelect: () => void snapshot() },
            { key: 'export', label: '导出数据', icon: <Download size={14} />, onSelect: () => void exportData(false) },
            {
              key: 'export-config',
              label: '导出数据和配置',
              icon: <Download size={14} />,
              onSelect: () => void exportData(true),
            },
            {
              key: 'import',
              label: '从数据文件导入…',
              icon: <Upload size={14} />,
              onSelect: () => chooser.current?.click(),
            },
            ...(others.length > 0
              ? [
                  {
                    key: 'from-extension',
                    label: '从另一个扩展迁入…',
                    icon: <FolderInput size={14} />,
                    onSelect: () => setChoosing(true),
                  },
                ]
              : []),
          ]}
        />
      }
    >
      <FileChooser
        ref={chooser}
        accept=".nxt-extension-data,.zip,application/zip"
        onFile={(file) => void inspect(file)}
      />
      {state === undefined ? (
        <Skeleton height={48} />
      ) : (
        <>
          <dl className={styles.facts}>
            <div>
              <dt>数据格式</dt>
              <dd>第 {state.dataVersion} 版</dd>
            </div>
            <div>
              <dt>记录</dt>
              <dd>{state.counts.storage} 条</dd>
            </div>
            <div>
              <dt>索引</dt>
              <dd>{state.counts.index} 条</dd>
            </div>
            <div>
              <dt>素材</dt>
              <dd>{state.counts.library} 个</dd>
            </div>
          </dl>
          {state.snapshots.length > 0 ? (
            <ul className={styles.snapshots}>
              {state.snapshots.map((item) => (
                <li key={item.id}>
                  <span>
                    <b>{item.reason === 'manual' ? item.label : SNAPSHOT_REASON[item.reason]}</b>
                    <small>
                      {relativeTime(item.createdAt)} · 第 {item.dataVersion} 版格式 · {size(item.byteSize)}
                    </small>
                  </span>
                  <Button
                    size="small"
                    variant="ghost"
                    onClick={() =>
                      setSource({
                        kind: 'snapshot',
                        snapshotId: item.id,
                        name: `${relativeTime(item.createdAt)}的快照`,
                      })
                    }
                  >
                    恢复
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.hint}>还没有快照。</p>
          )}
        </>
      )}
      <ChooseExtensionDialog
        open={choosing}
        onOpenChange={setChoosing}
        candidates={others}
        onChoose={(chosen) => {
          setChoosing(false)
          setSource({ kind: 'extension', extensionId: chosen.id, name: chosen.name })
        }}
      />
      <MigrationDialog
        extension={extension}
        source={source}
        onClose={() => setSource(undefined)}
        onDone={() => {
          setSource(undefined)
          void load()
        }}
      />
    </PropertyGroup>
  )
}

function ChooseExtensionDialog({
  open,
  onOpenChange,
  candidates,
  onChoose,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly candidates: readonly LocalExtensionSummary[]
  readonly onChoose: (extension: LocalExtensionSummary) => void
}) {
  const [chosen, setChosen] = useState('')
  const extension = candidates.find((item) => item.id === chosen)
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="从哪个扩展迁入数据？"
      actions={
        <>
          <Button onClick={() => onOpenChange(false)}>取消</Button>
          <Button variant="primary" disabled={!extension} onClick={() => extension && onChoose(extension)}>
            下一步
          </Button>
        </>
      }
    >
      <Field label="来源扩展" hint="通常是这个扩展的原版或另一条分支。">
        <Select
          aria-label="来源扩展"
          value={chosen}
          onValueChange={setChosen}
          options={candidates.map((item) => ({ value: item.id, label: item.name }))}
        />
      </Field>
    </Dialog>
  )
}

/**
 * Explicit data migration with a dry run first. Overwrite keeps what the target has and lets the source win on the
 * same keys; replace empties the target first. Anything that would overwrite or delete existing data asks the user to
 * type the extension's name; a snapshot of the target is always kept.
 */
function MigrationDialog({
  extension,
  source,
  onClose,
  onDone,
}: {
  readonly extension: LocalExtensionSummary
  readonly source: MigrationSource | undefined
  readonly onClose: () => void
  readonly onDone: () => void
}) {
  const agents = useProductStore((state) => state.agents)
  const [mode, setMode] = useState<'overwrite' | 'replace'>('overwrite')
  const [includeConfig, setIncludeConfig] = useState(false)
  const [agentMap, setAgentMap] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<Preview>()
  const [error, setError] = useState('')
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const packageAgents = source?.kind === 'package' ? source.inspection.agents : []

  useEffect(() => {
    if (!source) return
    setMode(source.kind === 'snapshot' ? 'replace' : 'overwrite')
    setIncludeConfig(false)
    setTyped('')
    setError('')
    // Agents of a data file map to the local agent with the same id when there is one.
    setAgentMap(
      Object.fromEntries(
        (source.kind === 'package' ? source.inspection.agents : [])
          .filter((agent) => agents.some((local) => local.id === agent.id))
          .map((agent) => [agent.id, agent.id]),
      ),
    )
  }, [source])

  const request = () => {
    if (!source) return undefined
    return {
      source:
        source.kind === 'extension'
          ? ({ kind: 'extension', extensionId: source.extensionId } as const)
          : source.kind === 'snapshot'
            ? ({ kind: 'snapshot', snapshotId: source.snapshotId } as const)
            : ({ kind: 'package', token: source.inspection.token } as const),
      mode,
      ...(source.kind === 'package' ? { agentMap } : {}),
      ...(includeConfig && source.kind !== 'snapshot' ? { includeConfig: true } : {}),
    }
  }
  useEffect(() => {
    const body = request()
    if (!body) return
    let live = true
    setPreview(undefined)
    callHostApi(HostApiContracts.previewExtensionDataMigration, { extensionId: extension.id }, body)
      .then((result) => live && (setPreview(result), setError('')))
      .catch((caught: unknown) => live && setError(caught instanceof Error ? caught.message : String(caught)))
    return () => {
      live = false
    }
  }, [source, mode, includeConfig, JSON.stringify(agentMap)])

  const destructive = preview?.destructive === true
  const tooNew = preview !== undefined && preview.sourceDataVersion > preview.targetDataVersion
  const confirmed = !destructive || typed.trim() === extension.name
  const configChanges =
    preview?.config === undefined
      ? 0
      : preview.config.hostFields.length + preview.config.agents.reduce((sum, entry) => sum + entry.fields.length, 0)

  const migrate = async () => {
    const body = request()
    if (!body) return
    setBusy(true)
    try {
      await callHostApi(HostApiContracts.migrateExtensionData, { extensionId: extension.id }, body)
      toast(`已迁移到「${extension.name}」，迁移前的数据留了快照`)
      onDone()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const sourceName =
    source === undefined
      ? ''
      : source.kind === 'package'
        ? `数据文件（${source.inspection.displayName}，${relativeTime(source.inspection.exportedAt)}导出）`
        : source.name
  const diff = preview?.diff
  return (
    <Dialog
      open={source !== undefined}
      onOpenChange={(open) => !open && !busy && onClose()}
      title={source?.kind === 'snapshot' ? '恢复快照' : `迁入「${extension.name}」`}
      wide
      actions={
        <>
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            busy={busy}
            disabled={!preview || tooNew || !confirmed}
            onClick={() => void migrate()}
          >
            {source?.kind === 'snapshot' ? '恢复' : '迁移'}
          </Button>
        </>
      }
    >
      <p style={{ margin: 0 }}>
        来源：{sourceName}
        {source?.kind === 'package'
          ? `，记录 ${source.inspection.counts.storage} 条、索引 ${source.inspection.counts.index} 条、素材 ${source.inspection.counts.library} 个`
          : ''}
      </p>
      <Field label="方式">
        <Segmented
          label="迁移方式"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'overwrite', label: '覆盖' },
            { value: 'replace', label: '替换' },
          ]}
        />
      </Field>
      <p className={styles.hint}>
        {mode === 'overwrite'
          ? '保留目标已有的数据；同一条记录两边都有时，以来源为准。'
          : '先清空目标的全部数据，再写入来源的数据。目标独有的记录会被删除。'}
      </p>
      {packageAgents.length > 0 ? (
        <Field
          label="智能体的数据交给谁"
          hint="数据文件里每个智能体各自的数据，迁到这台机器上的哪个智能体；不选的跳过。"
        >
          <div className={styles.agentMap}>
            {packageAgents.map((agent) => (
              <label key={agent.id}>
                <span>{agent.name}</span>
                <Select
                  aria-label={`${agent.name}的数据`}
                  value={agentMap[agent.id] ?? ''}
                  onValueChange={(value) =>
                    setAgentMap((current) => {
                      const next = { ...current }
                      if (value === '') delete next[agent.id]
                      else next[agent.id] = value
                      return next
                    })
                  }
                  options={[
                    { value: '', label: '跳过' },
                    ...agents.map((local) => ({ value: local.id, label: local.name })),
                  ]}
                />
              </label>
            ))}
          </div>
        </Field>
      ) : null}
      {source && source.kind !== 'snapshot' ? (
        <SwitchRow
          title="连同配置一起迁移"
          description="本机配置和各智能体的配置按同样方式迁移；API Key 等凭据不迁移，目标保留自己的。"
          checked={includeConfig}
          onCheckedChange={setIncludeConfig}
        />
      ) : null}
      {error ? <Banner tone="bad">{error}</Banner> : null}
      {diff === undefined && !error ? <Skeleton height={56} /> : null}
      {diff ? (
        <dl className={styles.facts}>
          <div>
            <dt>新增</dt>
            <dd>{diff.storage.added} 条</dd>
          </div>
          <div>
            <dt>覆盖</dt>
            <dd>{diff.storage.overwritten} 条</dd>
          </div>
          <div>
            <dt>删除</dt>
            <dd>{diff.storage.removed} 条</dd>
          </div>
          <div>
            <dt>不变</dt>
            <dd>{diff.storage.unchanged} 条</dd>
          </div>
          <div>
            <dt>索引</dt>
            <dd>
              +{diff.index.added} / ~{diff.index.overwritten} / -{diff.index.removed}
            </dd>
          </div>
          <div>
            <dt>素材</dt>
            <dd>
              +{diff.library.added} / -{diff.library.removed}
            </dd>
          </div>
          {preview?.config ? (
            <div>
              <dt>配置</dt>
              <dd>{configChanges} 项</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {tooNew ? (
        <Banner tone="bad">
          来源数据是第 {preview.sourceDataVersion} 版格式，这个扩展当前的版本只认识第 {preview.targetDataVersion}{' '}
          版。先把它切换到更新的版本再迁移。
        </Banner>
      ) : preview?.needsMigration ? (
        <Banner tone="info">
          来源数据是较早的第 {preview.sourceDataVersion} 版格式，写入后扩展启动时会自动升级到第{' '}
          {preview.targetDataVersion} 版。
        </Banner>
      ) : null}
      {destructive && !tooNew ? (
        <>
          <Banner tone="warn">
            {diff && diff.storage.removed + diff.index.removed + diff.library.removed > 0
              ? `会删除目标里的 ${diff.storage.removed} 条记录、${diff.index.removed} 条索引和 ${diff.library.removed} 个素材`
              : `会覆盖目标里的 ${diff?.storage.overwritten ?? 0} 条记录`}
            。迁移前会自动留一份快照，可以在这里恢复；但扩展在迁移后新写入的数据，恢复快照时会丢失。
          </Banner>
          <Field label={`输入「${extension.name}」确认`}>
            <Input value={typed} onChange={(event) => setTyped(event.target.value)} />
          </Field>
        </>
      ) : null}
    </Dialog>
  )
}
