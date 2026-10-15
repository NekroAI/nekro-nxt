import { HostApiContracts } from '@nekro-nxt/contracts'
import { Download, GitBranch, PencilLine, Repeat2, Share2 } from 'lucide-react'
import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import { callHostApi } from '../../host-api-client.js'
import { useProductStore, type LocalExtensionSummary } from '../../product-runtime.js'
import { Button, Chip, Skeleton } from '../../ui-kit/index.js'
import { relativeTime } from '../channels/timeline-model.js'
import { useGo } from '../model/nav.js'
import { layoutLineage, originLabel, type LineageLine, type PlacedNode } from './lineage-model.js'
import styles from './lineage.module.css'

type Revision = LocalExtensionSummary['revisions'][number]

const COLUMN = 76
const ROW = 58
const PAD_X = 30
const PAD_TOP = 30
const PAD_BOTTOM = 26
const RADIUS = 8

/** Line colours in family order; the extension on screen is always the first lane it appears in. */
const LANES = ['var(--accent)', 'var(--brass)', 'var(--ok)', 'var(--warn)', 'var(--risk-2)', 'var(--fg-2)']
const laneColor = (lane: number) => LANES[lane % LANES.length]

const at = (entry: PlacedNode) => ({ x: PAD_X + entry.column * COLUMN, y: PAD_TOP + entry.row * ROW })

export interface LineageActions {
  readonly onSwitch: (revision: Revision) => void
  readonly onBranch: (revision: Revision) => void
  readonly onPublish: (revision: Revision) => void
  readonly onExport: (revision: Revision) => void
  /** Opens a channel of an agent that can create, with a request to revise this version; absent without one. */
  readonly onRevise: ((revision: Revision) => void) | undefined
}

/**
 * The family tree of an extension: its versions, the branches made from them and branches of those branches. The
 * filled dot is the version in use; `#n` marks community releases. Selecting a version shows what can be done with it.
 */
export function LineageView({
  extension,
  actions,
}: {
  readonly extension: LocalExtensionSummary
  readonly actions: LineageActions
}) {
  const familySize = useProductStore((state) => state.extensions.length)
  const [lines, setLines] = useState<readonly LineageLine[]>()
  const [selected, setSelected] = useState<string>()
  const installed = extension.installation?.revisionId
  useEffect(() => {
    let live = true
    callHostApi(HostApiContracts.getExtensionLineage, { extensionId: extension.id }, undefined)
      .then((result) => live && setLines(result.lines))
      .catch(() => live && setLines([]))
    return () => {
      live = false
    }
  }, [extension.id, extension.revisions.length, installed, familySize])

  const layout = useMemo(() => (lines === undefined ? undefined : layoutLineage(lines)), [lines])
  if (lines === undefined || layout === undefined) return <Skeleton height={120} />

  const chosen =
    layout.nodes.find((entry) => entry.node.revisionId === selected) ??
    layout.nodes.find((entry) => entry.node.revisionId === installed) ??
    layout.nodes.findLast((entry) => entry.node.extensionId === extension.id)
  const width = PAD_X * 2 + Math.max(0, layout.columns - 1) * COLUMN
  const height = PAD_TOP + PAD_BOTTOM + Math.max(0, layout.rows - 1) * ROW
  const lineOf = (extensionId: string) => lines.find((line) => line.extensionId === extensionId)
  const nameOf = (extensionId: string) => lineOf(extensionId)?.displayName ?? '另一个扩展'
  const labelOf = (revisionId: string) =>
    lines.flatMap((line) => line.nodes).find((node) => node.revisionId === revisionId)?.label

  const select = (revisionId: string) => setSelected(revisionId)
  const onKey = (event: KeyboardEvent, revisionId: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      select(revisionId)
    }
  }

  return (
    <div className={styles.lineage}>
      {lines.length > 1 ? (
        <ul className={styles.legend} aria-label="扩展与分支">
          {lines.map((line, index) => (
            <li key={line.extensionId} style={{ ['--lane' as string]: laneColor(index) } as CSSProperties}>
              <span className={styles.swatch} aria-hidden="true" />
              {line.extensionId === extension.id ? (
                <b>{line.displayName}</b>
              ) : (
                <Link to={`/workshop/extensions/${line.extensionId}`}>{line.displayName}</Link>
              )}
              {line.branchOf ? (
                <span className={styles.legendSub}>
                  分支自{nameOf(line.branchOf.extensionId)} {labelOf(line.branchOf.revisionId) ?? ''}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className={styles.canvas}>
        <svg width={width} height={height} role="group" aria-label="版本谱系">
          {layout.edges.map((edge) => {
            const from = at(edge.from)
            const to = at(edge.to)
            const bend = (to.x - from.x) / 2
            const path =
              from.y === to.y
                ? `M ${from.x + RADIUS} ${from.y} L ${to.x - RADIUS} ${to.y}`
                : `M ${from.x} ${from.y + RADIUS} C ${from.x} ${to.y}, ${to.x - bend} ${to.y}, ${to.x - RADIUS} ${to.y}`
            return (
              <path
                key={`${edge.from.node.revisionId}-${edge.to.node.revisionId}`}
                className={styles.edge}
                data-kind={edge.kind}
                d={path}
                style={{ ['--lane' as string]: laneColor(edge.to.lane) } as CSSProperties}
              />
            )
          })}
          {layout.nodes.map((entry) => {
            const { x, y } = at(entry)
            const node = entry.node
            const other = node.extensionId !== extension.id
            const releases = node.releaseNumbers.map((number) => `#${number}`).join(' ')
            return (
              <g
                key={node.revisionId}
                className={styles.node}
                data-current={node.current}
                data-selected={chosen?.node.revisionId === node.revisionId}
                data-other={other}
                style={{ ['--lane' as string]: laneColor(entry.lane) } as CSSProperties}
                role="button"
                tabIndex={0}
                aria-label={`${other ? `${nameOf(node.extensionId)} ` : ''}${node.label}${node.current ? '，正在使用' : ''}${releases ? `，社区发布 ${releases}` : ''}`}
                aria-pressed={chosen?.node.revisionId === node.revisionId}
                onClick={() => select(node.revisionId)}
                onKeyDown={(event) => onKey(event, node.revisionId)}
              >
                <circle className={styles.halo} cx={x} cy={y} r={RADIUS + 5} />
                <circle className={styles.dot} cx={x} cy={y} r={RADIUS} />
                <text className={styles.label} x={x} y={y - RADIUS - 7}>
                  {node.label}
                </text>
                {releases ? (
                  <text className={styles.badge} x={x} y={y + RADIUS + 15}>
                    {releases}
                  </text>
                ) : null}
              </g>
            )
          })}
        </svg>
      </div>
      {chosen ? (
        <VersionDetail
          key={chosen.node.revisionId}
          entry={chosen}
          extension={extension}
          lineName={nameOf(chosen.node.extensionId)}
          parentLabel={chosen.node.parentRevisionId === undefined ? undefined : labelOf(chosen.node.parentRevisionId)}
          actions={actions}
        />
      ) : null}
    </div>
  )
}

function VersionDetail({
  entry,
  extension,
  lineName,
  parentLabel,
  actions,
}: {
  readonly entry: PlacedNode
  readonly extension: LocalExtensionSummary
  readonly lineName: string
  readonly parentLabel: string | undefined
  readonly actions: LineageActions
}) {
  const navigate = useGo()
  const node = entry.node
  if (node.extensionId !== extension.id) {
    return (
      <div className={styles.detail}>
        <div className={styles.detailHead}>
          <b>
            {lineName} {node.label}
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
  const users = extension.activations.filter((item) => item.revisionId === revision.id)
  const dataNewer = revision.dataVersion < extension.dataVersion
  return (
    <div className={styles.detail}>
      <div className={styles.detailHead}>
        <b>{node.label}</b>
        {node.current ? <Chip tone="ok">正在使用</Chip> : null}
        {users.length > 0 ? <Chip tone="ok">{users.map((item) => item.agentName).join('、')} 在用</Chip> : null}
        {revision.releases.map((release) => (
          <Chip key={`${release.communityUrl}:${release.releaseId}`} tone="accent">
            {release.via === 'publish' ? '已发布' : '社区'}
            {release.number ? ` #${release.number}` : ''}
          </Chip>
        ))}
        {!usable ? <Chip tone="warn">格式不受支持</Chip> : null}
      </div>
      <dl className={styles.facts}>
        <div>
          <dt>来源</dt>
          <dd>{originLabel[node.origin]}</dd>
        </div>
        <div>
          <dt>保存于</dt>
          <dd>{relativeTime(node.createdAt)}</dd>
        </div>
        <div>
          <dt>基于</dt>
          <dd>{parentLabel ?? (extension.branchOf && node.parentRevisionId === undefined ? '分支起点' : '最早的版本')}</dd>
        </div>
        <div>
          <dt>数据格式</dt>
          <dd>第 {revision.dataVersion} 版</dd>
        </div>
        <div>
          <dt>内容</dt>
          <dd>{revision.contributions.length} 项</dd>
        </div>
      </dl>
      {dataNewer && !node.current ? (
        <p className={styles.hint}>
          本机数据已经是第 {extension.dataVersion} 版格式，切换到这个版本需要先恢复一份旧格式的数据快照。
        </p>
      ) : null}
      <div className={styles.actions}>
        {!node.current && usable ? (
          <Button size="small" variant="primary" icon={<Repeat2 size={14} />} onClick={() => actions.onSwitch(revision)}>
            {extension.installation ? '切换到这个版本' : '安装这个版本'}
          </Button>
        ) : null}
        {actions.onRevise ? (
          <Button size="small" icon={<PencilLine size={14} />} onClick={() => actions.onRevise?.(revision)}>
            让智能体在此基础上修改
          </Button>
        ) : null}
        <Button size="small" icon={<GitBranch size={14} />} disabled={!usable} onClick={() => actions.onBranch(revision)}>
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
      </div>
    </div>
  )
}
