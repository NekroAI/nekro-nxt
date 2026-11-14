import { HostApiContracts } from '@nekro-nxt/contracts'
import {
  Bookmark,
  BookmarkCheck,
  ChevronRight,
  Download,
  GitBranch,
  Globe,
  PencilLine,
  Repeat2,
  Share2,
  Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { callHostApi } from '../../host-api-client.js'
import { useProductStore, type LocalExtensionSummary } from '../../product-runtime.js'
import { Button, Checkbox, Chip, ConfirmDialog, Pressable, Skeleton, toast } from '../../ui-kit/index.js'
import { relativeTime } from '../channels/timeline-model.js'
import { useGo } from '../model/nav.js'
import { buildTimeline, type LineageLine, type LineageNode, type TimelineRow } from './lineage-model.js'
import { describeVersion, type VersionText } from './version-text.js'
import styles from './lineage.module.css'

type Revision = LocalExtensionSummary['revisions'][number]

const DAY_HEIGHT = 32
const NODE_HEIGHT = 60
const FOLD_HEIGHT = 48
const PAD_TOP = 8
const LANE_START = 26
const LANE_GAP = 26
const FOLD_GAP = 15

/** Rail colours in family order; the extension on screen is always the first lane it appears in. */
const LANES = ['var(--accent)', 'var(--brass)', 'var(--ok)', 'var(--warn)', 'var(--risk-2)', 'var(--fg-2)']
const laneColor = (lane: number) => LANES[lane % LANES.length]!
const laneX = (lane: number) => LANE_START + lane * LANE_GAP
const rowHeight = (row: TimelineRow) =>
  row.kind === 'day' ? DAY_HEIGHT : row.kind === 'fold' ? FOLD_HEIGHT : NODE_HEIGHT

/** Versions people recognise at a glance get a ringed dot; the rest stay grey. */
const marked = (node: LineageNode) =>
  node.protectedBy === 'active' ||
  node.protectedBy === 'released' ||
  node.protectedBy === 'kept' ||
  node.protectedBy === 'branch'

export interface LineageActions {
  readonly onSwitch: (revision: Revision) => void
  /** A switch is under way (or waiting for the agents to finish replying); another one waits until it settles. */
  readonly switchBusy?: boolean
  readonly onBranch: (revision: Revision) => void
  readonly onPublish: (revision: Revision) => void
  readonly onExport: (revision: Revision) => void
  /** Opens a channel of an agent that can create, with a request to revise this version; absent without one. */
  readonly onRevise: ((revision: Revision) => void) | undefined
}

const clock = (at: number) =>
  new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
const date = (at: number) => `${new Date(at).getMonth() + 1}月${new Date(at).getDate()}日`

/** When a run of versions was saved: times within one day, days across several. */
const span = (from: number, to: number) => {
  if (date(from) !== date(to)) return `${date(from)}—${date(to)}`
  return clock(from) === clock(to) ? clock(from) : `${clock(from)}—${clock(to)}`
}

const failure = (error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })

/**
 * Every version of an extension and of the branches in its family, newest on top, each line on its own rail (#90).
 * The version in use and versions something still needs keep their own row; runs of other versions fold into one
 * row that can be expanded or cleaned up. Selecting a row shows what can be done with it beside the timeline.
 */
export function LineageView({
  extension,
  actions,
}: {
  readonly extension: LocalExtensionSummary
  readonly actions: LineageActions
}) {
  const extensions = useProductStore((state) => state.extensions)
  const tasks = useProductStore((state) => state.authoringTasks)
  const agents = useProductStore((state) => state.agents)
  const [lines, setLines] = useState<readonly LineageLine[]>()
  const [reload, setReload] = useState(0)
  const [selected, setSelected] = useState<string>()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const installed = extension.installation?.revisionId
  const familySize = extensions.length
  const activations = extension.activations.map((item) => `${item.agentId}:${item.revisionId}`).join(',')
  useEffect(() => {
    let live = true
    callHostApi(HostApiContracts.getExtensionLineage, { extensionId: extension.id }, undefined)
      .then((result) => live && setLines(result.lines))
      .catch(() => live && setLines([]))
    return () => {
      live = false
    }
  }, [extension.id, extension.revisions.length, installed, familySize, activations, reload])

  const timeline = useMemo(
    () => (lines === undefined ? undefined : buildTimeline(lines, { expanded, now: Date.now() })),
    [lines, expanded],
  )
  if (lines === undefined || timeline === undefined) return <Skeleton height={240} />

  const lineOf = (extensionId: string) => lines.find((line) => line.extensionId === extensionId)
  const nameOf = (extensionId: string) => lineOf(extensionId)?.displayName ?? '另一个扩展'
  const revisionOf = (node: LineageNode) =>
    extensions.find((item) => item.id === node.extensionId)?.revisions.find((item) => item.id === node.revisionId)
  // Versions of every line read the same way: date, what changed, where it came from (interaction model §2.5).
  const textOf = (node: LineageNode) => {
    const revision = revisionOf(node)
    return describeVersion(
      revision === undefined
        ? {
            createdAt: node.createdAt,
            origin: node.origin,
            versionLabel: node.label,
            releases: node.releaseNumbers.map((number) => ({ number })),
          }
        : { ...revision, createdAt: node.createdAt },
      {
        siblings: lineOf(node.extensionId)?.nodes.map((item) => item.createdAt) ?? [],
        tasks,
        agentName: (agentId) => agents.find((agent) => agent.id === agentId)?.name,
      },
    )
  }
  const labelOf = (revisionId: string) => {
    const node = lines.flatMap((line) => line.nodes).find((item) => item.revisionId === revisionId)
    return node ? textOf(node).title : undefined
  }
  const usersOf = (node: LineageNode) =>
    extensions
      .find((item) => item.id === node.extensionId)
      ?.activations.filter((item) => item.revisionId === node.revisionId)
      .map((item) => item.agentName) ?? []

  const chosen =
    timeline.rows.find((row) => row.key === selected && row.kind !== 'day') ??
    timeline.rows.find((row) => row.kind === 'node' && row.node.extensionId === extension.id && row.node.current) ??
    timeline.rows.find((row) => row.kind === 'node' && row.node.extensionId === extension.id)

  // Row centres, for the rails drawn behind the rows.
  const centre = new Map<string, number>()
  let height = PAD_TOP
  for (const row of timeline.rows) {
    centre.set(row.key, height + rowHeight(row) / 2)
    height += rowHeight(row)
  }
  height += PAD_TOP
  const textX = laneX(timeline.lanes - 1) + 28

  // Each line is one rail; across a fold it breaks into the fold's own dots.
  const rails = Array.from({ length: timeline.lanes }, (_, lane) => {
    const own = timeline.rows.filter((row) => row.kind !== 'day' && row.lane === lane)
    const segments: { from: number; to: number }[] = []
    let from = own[0] === undefined ? undefined : centre.get(own[0].key)
    for (const row of own) {
      if (row.kind !== 'fold') continue
      const y = centre.get(row.key)!
      if (from !== undefined && from < y - FOLD_GAP) segments.push({ from, to: y - FOLD_GAP })
      from = y + FOLD_GAP
    }
    const last = own.at(-1)
    const end = last === undefined ? undefined : centre.get(last.key)
    if (from !== undefined && end !== undefined && end > from) segments.push({ from, to: end })
    return segments
  })

  const refresh = () => setReload((value) => value + 1)

  return (
    <div className={styles.versions}>
      <div className={styles.legendRow}>
        <ul className={styles.legend} aria-label="图例">
          <li>
            <svg width="14" height="14" aria-hidden="true">
              <circle cx="7" cy="7" r="5.5" fill={laneColor(0)} />
            </svg>
            正在使用
          </li>
          <li>
            <svg width="14" height="14" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" fill="var(--surface)" stroke={laneColor(0)} strokeWidth="2" />
              <circle cx="7" cy="7" r="1.6" fill={laneColor(0)} />
            </svg>
            有智能体在用、发布过或已保留
          </li>
          <li>
            <svg width="14" height="14" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" fill="var(--surface)" stroke="var(--line-3)" strokeWidth="2" />
            </svg>
            其他版本
          </li>
        </ul>
        {lines.length > 1 ? (
          <ul className={styles.legend} aria-label="扩展与分支">
            {lines.map((line, index) => (
              <li key={line.extensionId} style={{ ['--lane' as string]: laneColor(index) }}>
                <span className={styles.swatch} aria-hidden="true" />
                {line.extensionId === extension.id ? (
                  <b>{line.displayName}</b>
                ) : (
                  <Link to={`/workshop/extensions/${line.extensionId}`}>{line.displayName}</Link>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className={styles.layout}>
        <div
          className={styles.timeline}
          role="group"
          aria-label="版本谱系"
          style={{ ['--text-x' as string]: `${textX}px` }}
        >
          <svg className={styles.rails} width={textX} height={height} aria-hidden="true">
            {rails.map((segments, lane) =>
              segments.map((segment) => (
                <line
                  key={`${lane}-${segment.from}`}
                  className={styles.rail}
                  stroke={laneColor(lane)}
                  x1={laneX(lane)}
                  x2={laneX(lane)}
                  y1={segment.from}
                  y2={segment.to}
                />
              )),
            )}
            {timeline.branches.map((branch) => {
              const fromY = centre.get(branch.from)!
              const toY = centre.get(branch.to)!
              const origin = timeline.rows.find((row) => row.key === branch.from)
              const x0 = laneX(origin?.kind === 'node' ? origin.lane : 0)
              const x1 = laneX(branch.lane)
              const bend = Math.min(40, (fromY - toY) / 2)
              return (
                <path
                  key={branch.to}
                  className={styles.rail}
                  stroke={laneColor(branch.lane)}
                  fill="none"
                  d={`M ${x0} ${fromY - 8} C ${x0} ${fromY - bend}, ${x1} ${toY + bend}, ${x1} ${toY}`}
                />
              )
            })}
            {timeline.rows.map((row) => {
              if (row.kind === 'day') return null
              const x = laneX(row.lane)
              const y = centre.get(row.key)!
              const color = laneColor(row.lane)
              if (row.kind === 'fold')
                return (
                  <g key={row.key} fill={color} opacity={0.6}>
                    {[-8, 0, 8].map((offset) => (
                      <circle key={offset} cx={x} cy={y + offset} r={2.4} />
                    ))}
                  </g>
                )
              if (row.node.current)
                return (
                  <g key={row.key}>
                    <circle cx={x} cy={y} r={12} fill={color} opacity={0.14} />
                    <circle cx={x} cy={y} r={7} fill={color} />
                    <circle cx={x} cy={y} r={2.6} fill="var(--surface)" />
                  </g>
                )
              if (marked(row.node))
                return (
                  <g key={row.key}>
                    <circle cx={x} cy={y} r={6.5} fill="var(--surface)" stroke={color} strokeWidth={2.5} />
                    <circle cx={x} cy={y} r={2.4} fill={color} />
                  </g>
                )
              return <circle key={row.key} className={styles.plainDot} cx={x} cy={y} r={5.5} />
            })}
          </svg>
          {timeline.rows.map((row) => {
            if (row.kind === 'day')
              return (
                <div key={row.key} className={styles.day}>
                  {row.label}
                </div>
              )
            const isSelected = chosen?.key === row.key
            if (row.kind === 'fold') {
              const newest = row.nodes[0]!
              const oldest = row.nodes.at(-1)!
              return (
                <Pressable
                  key={row.key}
                  className={styles.foldRow}
                  data-selected={isSelected}
                  aria-pressed={isSelected}
                  onClick={() => setSelected(row.key)}
                >
                  <span className={styles.pill}>
                    <ChevronRight size={14} aria-hidden="true" />
                    <b>{row.nodes.length} 个中间版本</b>
                    <span className={styles.when}>{span(oldest.createdAt, newest.createdAt)}</span>
                  </span>
                </Pressable>
              )
            }
            const node = row.node
            const text = textOf(node)
            const users = usersOf(node)
            const other = node.extensionId !== extension.id
            return (
              <Pressable
                key={row.key}
                className={styles.row}
                data-selected={isSelected}
                aria-pressed={isSelected}
                aria-label={`${other ? `${nameOf(node.extensionId)} ` : ''}${text.title}${node.current ? '，正在使用' : ''}`}
                onClick={() => setSelected(row.key)}
              >
                <span className={styles.rowText}>
                  <span className={styles.rowTitle}>
                    {text.title}
                    <span className={styles.code}>{node.label}</span>
                  </span>
                  <span className={styles.rowMeta}>
                    {other ? `${nameOf(node.extensionId)} · ` : ''}
                    {text.source}
                  </span>
                </span>
                <span className={styles.chips}>
                  {node.current ? (
                    <Chip tone="ok" dot>
                      正在使用
                    </Chip>
                  ) : null}
                  {users.length > 0 ? (
                    <Chip>{users.length > 2 ? `${users.length} 个智能体在用` : `${users.join('、')} 在用`}</Chip>
                  ) : null}
                  {node.kept ? (
                    <Chip tone="warn" icon={<Bookmark size={12} />}>
                      已保留
                    </Chip>
                  ) : null}
                  {node.releaseNumbers.length > 0 ? (
                    <Chip tone="accent" icon={<Globe size={12} />}>
                      社区
                    </Chip>
                  ) : null}
                  {node.protectedBy === 'branch' ? <Chip icon={<GitBranch size={12} />}>分叉点</Chip> : null}
                </span>
              </Pressable>
            )
          })}
          <div style={{ height: PAD_TOP }} />
        </div>
        <div className={styles.panel}>
          {chosen?.kind === 'fold' ? (
            <FoldDetail
              key={chosen.key}
              nodes={chosen.nodes}
              textOf={textOf}
              onExpand={() => {
                setExpanded((current) => new Set([...current, chosen.key]))
                setSelected(undefined)
              }}
              onCleaned={() => {
                setSelected(undefined)
                refresh()
              }}
            />
          ) : chosen?.kind === 'node' ? (
            <VersionDetail
              key={chosen.key}
              node={chosen.node}
              extension={extension}
              lineName={nameOf(chosen.node.extensionId)}
              text={textOf(chosen.node)}
              users={usersOf(chosen.node)}
              parentLabel={
                chosen.node.parentRevisionId === undefined ? undefined : labelOf(chosen.node.parentRevisionId)
              }
              actions={actions}
              onChanged={refresh}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}

function FoldDetail({
  nodes,
  textOf,
  onExpand,
  onCleaned,
}: {
  readonly nodes: readonly LineageNode[]
  readonly textOf: (node: LineageNode) => VersionText
  readonly onExpand: () => void
  readonly onCleaned: () => void
}) {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(nodes.map((node) => node.revisionId)))
  const [confirming, setConfirming] = useState(false)
  const newest = nodes[0]!
  const oldest = nodes.at(-1)!
  const toggle = (revisionId: string, checked: boolean) =>
    setChosen((current) => {
      const next = new Set(current)
      if (checked) next.add(revisionId)
      else next.delete(revisionId)
      return next
    })
  const clean = async () => {
    const revisionIds = nodes.filter((node) => chosen.has(node.revisionId)).map((node) => node.revisionId)
    await callHostApi(HostApiContracts.deleteExtensionRevisions, { extensionId: newest.extensionId }, { revisionIds })
    toast(`已清理 ${revisionIds.length} 个版本`)
    onCleaned()
  }
  return (
    <div className={styles.detail}>
      <div className={styles.detailHead}>
        <b>{nodes.length} 个中间版本</b>
      </div>
      <p className={styles.hint}>{span(oldest.createdAt, newest.createdAt)} · 这些版本没有在用，也没有保留或发布过</p>
      <ul className={styles.foldList} aria-label="中间版本">
        {nodes.map((node) => {
          const text = textOf(node)
          return (
            <li key={node.revisionId}>
              <label className={styles.foldPick}>
                <Checkbox
                  label={text.title}
                  checked={chosen.has(node.revisionId)}
                  onChange={(checked) => toggle(node.revisionId, checked)}
                />
                <span className={styles.foldItem}>
                  <span>{text.title}</span>
                  <small>{text.source}</small>
                </span>
                <span className={styles.code}>{node.label}</span>
              </label>
            </li>
          )
        })}
      </ul>
      <p className={styles.hint}>清理后不能恢复，前后的版本会直接相连。</p>
      <div className={styles.foldActions}>
        <Button size="small" variant="ghost" onClick={onExpand}>
          在图上展开
        </Button>
        <Button
          size="small"
          variant="danger"
          icon={<Trash2 size={14} />}
          disabled={chosen.size === 0}
          onClick={() => setConfirming(true)}
        >
          清理选中的 {chosen.size} 个
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`清理 ${chosen.size} 个版本？`}
        confirmLabel="清理"
        danger
        onConfirm={() => clean().catch(failure)}
      >
        这些版本的源码会从这台设备上删除，不能恢复。
      </ConfirmDialog>
    </div>
  )
}

function VersionDetail({
  node,
  extension,
  lineName,
  text,
  users,
  parentLabel,
  actions,
  onChanged,
}: {
  readonly node: LineageNode
  readonly extension: LocalExtensionSummary
  readonly lineName: string
  readonly text: VersionText
  readonly users: readonly string[]
  readonly parentLabel: string | undefined
  readonly actions: LineageActions
  readonly onChanged: () => void
}) {
  const navigate = useGo()
  const [deleting, setDeleting] = useState(false)
  if (node.extensionId !== extension.id) {
    return (
      <div className={styles.detail}>
        <div className={styles.detailHead}>
          <b>
            {lineName} · {text.title}
          </b>
          {node.current ? <Chip tone="ok">正在使用</Chip> : null}
        </div>
        <p className={styles.hint}>这是同一谱系里的另一个扩展，打开它可以查看和操作它的版本。</p>
        <div className={styles.actions}>
          <Button size="small" onClick={() => navigate(`/workshop/extensions/${node.extensionId}`)}>
            打开「{lineName}」
          </Button>
        </div>
      </div>
    )
  }
  const revision = extension.revisions.find((item) => item.id === node.revisionId)
  if (!revision) return null
  const usable = revision.format === undefined || revision.format === 'current'
  const dataNewer = revision.dataVersion < extension.dataVersion
  const startsBranch = extension.branchOf !== undefined && node.parentRevisionId === undefined
  const basedOn = parentLabel ?? (startsBranch ? '分支起点' : '最早的版本')
  const keep = (kept: boolean) =>
    callHostApi(
      HostApiContracts.setExtensionRevisionKept,
      { extensionId: extension.id, revisionId: node.revisionId },
      { kept },
    )
      .then(() => {
        toast(kept ? '已保留这个版本' : '已取消保留')
        onChanged()
      })
      .catch(failure)
  const remove = async () => {
    await callHostApi(
      HostApiContracts.deleteExtensionRevisions,
      { extensionId: extension.id },
      { revisionIds: [node.revisionId] },
    )
    toast('已删除这个版本')
    onChanged()
  }
  return (
    <div className={styles.detail}>
      <div className={styles.detailHead}>
        <b>{text.title}</b>
      </div>
      <div className={styles.chipsWrap}>
        {node.current ? (
          <Chip tone="ok" dot>
            正在使用
          </Chip>
        ) : null}
        {users.length > 0 ? <Chip>{users.join('、')} 在用</Chip> : null}
        {node.kept ? (
          <Chip tone="warn" icon={<Bookmark size={12} />}>
            已保留
          </Chip>
        ) : null}
        {revision.releases.map((release) => (
          <Chip key={`${release.communityUrl}:${release.releaseId}`} tone="accent">
            {release.via === 'publish' ? '已发布' : '社区'}
          </Chip>
        ))}
        {!usable ? <Chip tone="warn">格式不受支持</Chip> : null}
      </div>
      <dl className={styles.facts}>
        <dt>来源</dt>
        <dd>{text.source}</dd>
        <dt>保存于</dt>
        <dd>{relativeTime(node.createdAt)}</dd>
        <dt>基于</dt>
        <dd>{basedOn}</dd>
        <dt>编号</dt>
        <dd>{text.code}</dd>
        <dt>数据格式</dt>
        <dd>第 {revision.dataVersion} 版</dd>
        <dt>内容</dt>
        <dd>{revision.contributions.length} 项</dd>
      </dl>
      {dataNewer && !node.current ? (
        <p className={styles.hint}>
          本机数据已经是第 {extension.dataVersion} 版格式，切换到这个版本需要先恢复一份旧格式的数据快照。
        </p>
      ) : null}
      <div className={styles.actions}>
        {!node.current && usable ? (
          <Button
            size="small"
            variant="primary"
            icon={<Repeat2 size={14} />}
            disabled={actions.switchBusy}
            onClick={() => actions.onSwitch(revision)}
          >
            {extension.installation ? '切换到这个版本' : '安装这个版本'}
          </Button>
        ) : null}
        <Button
          size="small"
          icon={node.kept ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}
          onClick={() => void keep(!node.kept)}
        >
          {node.kept ? '取消保留' : '保留'}
        </Button>
        {actions.onRevise ? (
          <Button size="small" icon={<PencilLine size={14} />} onClick={() => actions.onRevise?.(revision)}>
            让智能体在此基础上修改
          </Button>
        ) : null}
        <Button
          size="small"
          icon={<GitBranch size={14} />}
          disabled={!usable}
          onClick={() => actions.onBranch(revision)}
        >
          从这里分支
        </Button>
        {usable ? (
          <Button size="small" icon={<Share2 size={14} />} onClick={() => actions.onPublish(revision)}>
            发布到社区
          </Button>
        ) : null}
        <Button size="small" variant="ghost" icon={<Download size={14} />} onClick={() => actions.onExport(revision)}>
          导出
        </Button>
        {node.protectedBy === undefined ? (
          <Button size="small" variant="ghost" icon={<Trash2 size={14} />} onClick={() => setDeleting(true)}>
            删除这个版本
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`删除「${text.title}」？`}
        confirmLabel="删除"
        danger
        onConfirm={() => remove().catch(failure)}
      >
        这个版本的源码会从这台设备上删除，不能恢复。基于它的版本会接到更早的版本上。
      </ConfirmDialog>
    </div>
  )
}
