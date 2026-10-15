import { useProductStore, type LocalExtensionSummary } from '../../product-runtime.js'
import type { AuthoringTask } from './workshop-model.js'

type Revision = LocalExtensionSummary['revisions'][number]

/**
 * How people tell versions apart (docs/NekroNxt界面交互模型.md §2.5): when it was saved, what changed and where it
 * came from. The lineage number and community release numbers stay in `code` for the small print.
 */
export interface VersionText {
  /** “10月11日”, with the time when another version of the line was saved the same day. */
  readonly when: string
  /** What the version changed, from the revise task that made it; absent when nothing says so. */
  readonly change?: string
  /** “水月荧修改”, “社区安装”… */
  readonly source: string
  /** “10月11日 · 加上下播通知”: the name used in sentences and dialog titles. */
  readonly title: string
  /** “10/11”: the label under a dot of the lineage graph. */
  readonly short: string
  /** “v3 · 社区 #2”: for feedback and troubleshooting only. */
  readonly code: string
}

const CHANGE_LIMIT = 24

const day = (at: number) => {
  const date = new Date(at)
  return `${date.getMonth() + 1}月${date.getDate()}日`
}
const clock = (at: number) =>
  new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

const shorten = (text: string) => {
  const line = text.replace(/\s+/gu, ' ').trim()
  return line.length > CHANGE_LIMIT ? `${line.slice(0, CHANGE_LIMIT - 1)}…` : line
}

export function describeVersion(
  revision: Pick<Revision, 'createdAt' | 'origin' | 'versionLabel'> & {
    readonly authoringTaskId?: string | undefined
    readonly releases: readonly { readonly number: number | null }[]
  },
  context: {
    /** Save times of every version of the same line, to know when the day alone is ambiguous. */
    readonly siblings: readonly number[]
    readonly tasks: readonly AuthoringTask[]
    readonly agentName: (agentId: string) => string | undefined
  },
): VersionText {
  const sameDay = context.siblings.filter((at) => day(at) === day(revision.createdAt)).length > 1
  const when = sameDay ? `${day(revision.createdAt)} ${clock(revision.createdAt)}` : day(revision.createdAt)
  const task = revision.authoringTaskId ? context.tasks.find((item) => item.id === revision.authoringTaskId) : undefined
  const author = task ? context.agentName(task.agentId) : undefined
  const change =
    task?.kind === 'revise' && task.requirementSummary.trim() ? shorten(task.requirementSummary) : undefined
  const release = revision.releases.find((item) => item.number !== null)
  const source =
    revision.origin === 'authored'
      ? `${author ?? '智能体'}${task?.kind === 'revise' ? '修改' : '创造'}`
      : revision.origin === 'community'
        ? release?.number
          ? `社区发布 #${release.number}`
          : '社区安装'
        : revision.origin === 'file'
          ? '文件导入'
          : '分支创建'
  const numbers = [...new Set(revision.releases.flatMap((item) => (item.number ? [item.number] : [])))]
  return {
    when,
    ...(change === undefined ? {} : { change }),
    source,
    title: change ? `${when} · ${change}` : `${when} 的版本`,
    short: `${new Date(revision.createdAt).getMonth() + 1}/${new Date(revision.createdAt).getDate()}`,
    code: [revision.versionLabel, ...numbers.map((number) => `社区 #${number}`)].join(' · '),
  }
}

/** `describeVersion` bound to the store: tasks and agent names of this machine, siblings from the extension. */
export function useVersionText(): (
  extension: LocalExtensionSummary | undefined,
  revisionId: string,
) => VersionText | undefined {
  const tasks = useProductStore((state) => state.authoringTasks)
  const agents = useProductStore((state) => state.agents)
  return (extension, revisionId) => {
    const revision = extension?.revisions.find((item) => item.id === revisionId)
    if (!extension || !revision) return undefined
    return describeVersion(revision, {
      siblings: extension.revisions.map((item) => item.createdAt),
      tasks,
      agentName: (agentId) => agents.find((agent) => agent.id === agentId)?.name,
    })
  }
}
