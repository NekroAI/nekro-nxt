import { useEffect, useState } from 'react'
import { ChevronRight, Clock3, Layers, Lock, NotebookPen, Search } from 'lucide-react'
import {
  promptDocumentPlainText,
  type ChannelContextPolicy,
  type ChannelMemoryActivity,
  type HostApiResponse,
} from '@nekro-nxt/contracts'
import { workspaceApi } from '../../host-api-client.js'
import { Button, Disclosure, InfoTip, Pressable, Select, toast } from '../../ui-kit/index.js'
import styles from './channels.module.css'
import { relativeTime } from './timeline-model.js'

type PolicyView = HostApiResponse<'getChannelContextPolicy'>
type PromptView = HostApiResponse<'getChannelPrompt'>
type PolicyField = keyof ChannelContextPolicy

const CHOICES: Readonly<Record<PolicyField, readonly { readonly value: number; readonly label: string }[]>> = {
  backlogTextChars: [
    { value: 10_000, label: '1 万字' },
    { value: 40_000, label: '4 万字' },
    { value: 100_000, label: '10 万字' },
    { value: 0, label: '不限制' },
  ],
  backlogImages: [
    { value: 0, label: '不查看' },
    { value: 3, label: '3 张' },
    { value: 6, label: '6 张' },
    { value: 12, label: '12 张' },
  ],
  idleReviewMinutes: [
    { value: 0, label: '关闭' },
    { value: 15, label: '15 分钟' },
    { value: 45, label: '45 分钟' },
    { value: 120, label: '2 小时' },
  ],
}

const SETTINGS: readonly { readonly field: PolicyField; readonly label: string; readonly tip: string }[] = [
  {
    field: 'backlogTextChars',
    label: '未读消息上限',
    tip: '智能体被唤醒时，从最新的未读消息往前逐条读取，超出上限的较早消息合并为一条摘要，需要时它会自行查阅聊天记录。跑团、记录类频道可以调高。',
  },
  {
    field: 'backlogImages',
    label: '未读图片上限',
    tip: '未读消息中最新的几张图片直接交给智能体，其余只提供编号，需要时再查看。直接查看的图片越多，之后每次回复越慢、费用越高。',
  },
  {
    field: 'idleReviewMinutes',
    label: '静默后整理',
    tip: '频道持续这么久没有新消息后，智能体回顾之前的对话，把需要长期记住的内容写入笔记。整理过程不会在频道发言。',
  },
]

const choiceLabel = (field: PolicyField, value: number): string =>
  CHOICES[field].find((choice) => choice.value === value)?.label ?? String(value)

const choicesWith = (field: PolicyField, current: number, defaults: ChannelContextPolicy) => {
  const choices = CHOICES[field].map((choice) =>
    choice.value === defaults[field] ? { ...choice, label: `${choice.label}（默认）` } : choice,
  )
  return choices.some((choice) => choice.value === current)
    ? choices
    : [...choices, { value: current, label: String(current) }]
}

/** One line for the collapsed settings row, so the current budget is readable without opening it. */
const policySummary = (policy: ChannelContextPolicy): string =>
  [
    choiceLabel('backlogTextChars', policy.backlogTextChars),
    policy.backlogImages === 0 ? '不看图' : `${policy.backlogImages} 张图`,
    policy.idleReviewMinutes === 0 ? '不自动整理' : choiceLabel('idleReviewMinutes', policy.idleReviewMinutes),
  ].join(' · ')

const ACTIVITY_ICON = {
  'history-search': Search,
  'notes-updated': NotebookPen,
  'backlog-folded': Layers,
  'idle-review': Clock3,
} as const

const activityText = (activity: ChannelMemoryActivity): string => {
  switch (activity.kind) {
    case 'history-search':
      return `检索「${activity.query}」${activity.sender ? `（${activity.sender}）` : ''} · ${activity.hits === 0 ? '无结果' : `${activity.hits} 条结果`}`
    case 'notes-updated':
      return `更新笔记 · 共 ${activity.chars} 字`
    case 'backlog-folded':
      return `读取未读 ${activity.foldedCount + activity.shownCount} 条 · 逐条 ${activity.shownCount} 条`
    case 'idle-review':
      return `无新消息 ${activity.quietMinutes} 分钟 · 整理笔记`
  }
}

const RECENT_ACTIVITIES = 5

/**
 * What the agent keeps about this channel: its notes, what it recently looked up or wrote down, and how much unread
 * backlog it takes in. Channel-level, so each group can differ.
 */
export function ChannelMemory({
  channelId,
  prompt,
  activities,
  onEditNotes,
}: {
  readonly channelId: string
  readonly prompt: PromptView | undefined
  readonly activities: readonly ChannelMemoryActivity[] | undefined
  readonly onEditNotes: () => void
}) {
  const [view, setView] = useState<PolicyView | undefined>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  useEffect(() => {
    setView(undefined)
    const controller = new AbortController()
    workspaceApi
      .getChannelContextPolicy(channelId, { signal: controller.signal })
      .then(setView)
      .catch(() => undefined)
    return () => controller.abort()
  }, [channelId])

  const update = async (field: PolicyField, value: number) => {
    if (view === undefined) return
    const policy = { ...view.policy, [field]: value }
    const matchesDefaults = SETTINGS.every(({ field: key }) => policy[key] === view.defaults[key])
    try {
      setView(await workspaceApi.updateChannelContextPolicy(channelId, { policy: matchesDefaults ? null : policy }))
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
    }
  }

  const notes = prompt?.notes
  const notesText = notes === undefined ? '' : promptDocumentPlainText(notes.document).trim()
  const notesPreview = notesText.replace(/\n\s*\n+/gu, '\n')
  const notesMeta =
    notes === undefined
      ? undefined
      : [
          notesText.length > 0 ? `${notesText.length} 字` : undefined,
          notes.updatedAt === undefined
            ? undefined
            : `${notes.updatedBy === 'admin' ? '管理员' : '智能体'}更新 · ${relativeTime(notes.updatedAt)}`,
        ]
          .filter(Boolean)
          .join(' · ')
  const recent = (activities ?? []).slice(0, RECENT_ACTIVITIES)

  return (
    <div className={styles.memoryCard}>
      <section className={styles.memorySection} aria-label="笔记">
        <div className={styles.memoryHead}>
          <span className={styles.memoryTitle}>
            笔记
            {notes?.locked ? (
              <span className={styles.memoryLocked}>
                <Lock size={12} aria-hidden="true" />
                已锁定
              </span>
            ) : null}
          </span>
          {notesMeta ? <span className={styles.memoryMeta}>{notesMeta}</span> : null}
          <Button size="small" variant="ghost" onClick={onEditNotes}>
            编辑
          </Button>
        </div>
        {notesText.length > 0 ? (
          <p className={styles.memoryNotes}>{notesPreview}</p>
        ) : (
          <p className={styles.memoryEmpty}>还没有内容。聊天中出现需要长期记住的事，智能体会自行记下。</p>
        )}
      </section>

      {recent.length > 0 ? (
        <section className={styles.memorySection} aria-label="最近操作">
          <div className={styles.memoryHead}>
            <span className={styles.memoryTitle}>最近操作</span>
          </div>
          <ol className={styles.memoryFeed}>
            {recent.map((activity, index) => {
              const Icon = ACTIVITY_ICON[activity.kind]
              const missed = activity.kind === 'history-search' && activity.hits === 0
              return (
                <li key={`${activity.kind}-${activity.at ?? index}-${index}`} data-missed={missed || undefined}>
                  <Icon size={14} aria-hidden="true" />
                  <span className={styles.memoryFeedText}>{activityText(activity)}</span>
                  {activity.at === undefined ? null : (
                    <time className={styles.memoryFeedTime} dateTime={new Date(activity.at).toISOString()}>
                      {relativeTime(activity.at)}
                    </time>
                  )}
                </li>
              )
            })}
          </ol>
        </section>
      ) : null}

      {view ? (
        <section className={[styles.memorySection, styles.memorySettingsSection].join(' ')} aria-label="读取与整理">
          <Pressable
            className={styles.memorySettingsToggle}
            aria-expanded={settingsOpen}
            aria-controls="channel-memory-settings"
            onClick={() => setSettingsOpen(!settingsOpen)}
          >
            <span className={styles.memoryTitle}>读取与整理</span>
            {view.custom ? <span className={styles.memoryTag}>已自定义</span> : null}
            <span className={styles.memoryMeta}>{policySummary(view.policy)}</span>
            <ChevronRight size={16} data-open={settingsOpen} aria-hidden="true" />
          </Pressable>
          <Disclosure open={settingsOpen} id="channel-memory-settings">
            <div className={styles.memorySettings}>
              {SETTINGS.map(({ field, label, tip }) => (
                <div key={field} className={styles.memorySetting}>
                  <span className={styles.memorySettingLabel}>
                    {label}
                    <InfoTip label={label}>{tip}</InfoTip>
                  </span>
                  <Select
                    aria-label={label}
                    value={String(view.policy[field])}
                    options={choicesWith(field, view.policy[field], view.defaults).map((choice) => ({
                      value: String(choice.value),
                      label: choice.label,
                    }))}
                    onValueChange={(value) => void update(field, Number(value))}
                  />
                </div>
              ))}
              {view.custom ? (
                <Button
                  size="small"
                  variant="ghost"
                  className={styles.memoryReset}
                  onClick={() =>
                    void workspaceApi
                      .updateChannelContextPolicy(channelId, { policy: null })
                      .then(setView)
                      .catch((error: unknown) =>
                        toast(error instanceof Error ? error.message : String(error), { tone: 'bad' }),
                      )
                  }
                >
                  恢复默认
                </Button>
              ) : null}
            </div>
          </Disclosure>
        </section>
      ) : null}
    </div>
  )
}
