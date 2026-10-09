import { useEffect, useState } from 'react'
import type { ChannelContextPolicy, ChannelMemoryActivity, HostApiResponse } from '@nekro-nxt/contracts'
import { workspaceApi } from '../../host-api-client.js'
import { PropertyList, PropertyRow, Select, toast } from '../../ui-kit/index.js'
import styles from './channels.module.css'
import { relativeTime } from './timeline-model.js'

type PolicyView = HostApiResponse<'getChannelContextPolicy'>
type PolicyField = keyof ChannelContextPolicy

const CHOICES: Readonly<Record<PolicyField, readonly { readonly value: number; readonly label: string }[]>> = {
  backlogTextChars: [
    { value: 10_000, label: '约 1 万字' },
    { value: 40_000, label: '约 4 万字' },
    { value: 100_000, label: '约 10 万字' },
    { value: 0, label: '全部' },
  ],
  backlogImages: [
    { value: 0, label: '不直接看' },
    { value: 3, label: '最新 3 张' },
    { value: 6, label: '最新 6 张' },
    { value: 12, label: '最新 12 张' },
  ],
  idleReviewMinutes: [
    { value: 0, label: '不整理' },
    { value: 15, label: '15 分钟后' },
    { value: 45, label: '45 分钟后' },
    { value: 120, label: '2 小时后' },
  ],
}

const ROWS: readonly { readonly field: PolicyField; readonly label: string; readonly tip: string }[] = [
  {
    field: 'backlogTextChars',
    label: '一次读入的消息',
    tip: '很久没被叫到时，积压的消息从新往旧逐条读这么多字，更早的只给它一句概括，需要时它会自己翻聊天记录。跑团、记录类的群可以调大。',
  },
  {
    field: 'backlogImages',
    label: '积压里直接看的图片',
    tip: '其余图片只给它编号，需要时再打开。直接看的图片越多，之后每次回复越慢、越贵。',
  },
  {
    field: 'idleReviewMinutes',
    label: '安静后整理笔记',
    tip: '群里安静这么久之后，它会回头看一遍，把值得长期记住的写进笔记。这一步不会在群里说话。',
  },
]

const choicesWith = (field: PolicyField, current: number, defaults: ChannelContextPolicy) => {
  const choices = CHOICES[field].map((choice) =>
    choice.value === defaults[field] ? { ...choice, label: `${choice.label}（默认）` } : choice,
  )
  return choices.some((choice) => choice.value === current)
    ? choices
    : [...choices, { value: current, label: String(current) }]
}

const activityText = (activity: ChannelMemoryActivity): string => {
  switch (activity.kind) {
    case 'history-search':
      return `查聊天记录「${activity.query}」${activity.sender ? `（${activity.sender}说的）` : ''}：${activity.hits === 0 ? '没找到' : `${activity.hits} 条`}`
    case 'notes-updated':
      return `改了笔记，现在 ${activity.chars} 字`
    case 'backlog-folded':
      return `积压 ${activity.foldedCount + activity.shownCount} 条，逐条读了最近 ${activity.shownCount} 条`
    case 'idle-review':
      return `安静 ${activity.quietMinutes} 分钟后回头整理`
  }
}

/** How much backlog the agent reads at once and what it did to remember; channel-level, so each group can differ. */
export function ChannelMemory({
  channelId,
  activities,
}: {
  readonly channelId: string
  readonly activities: readonly ChannelMemoryActivity[] | undefined
}) {
  const [view, setView] = useState<PolicyView | undefined>()
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
    const matchesDefaults = ROWS.every(({ field: key }) => policy[key] === view.defaults[key])
    try {
      setView(await workspaceApi.updateChannelContextPolicy(channelId, { policy: matchesDefaults ? null : policy }))
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
    }
  }

  return (
    <PropertyList>
      {view
        ? ROWS.map(({ field, label, tip }) => (
            <PropertyRow key={field} label={label} tip={tip} layout="stacked">
              <Select
                aria-label={label}
                value={String(view.policy[field])}
                options={choicesWith(field, view.policy[field], view.defaults).map((choice) => ({
                  value: String(choice.value),
                  label: choice.label,
                }))}
                onValueChange={(value) => void update(field, Number(value))}
              />
            </PropertyRow>
          ))
        : null}
      {activities && activities.length > 0 ? (
        <PropertyRow label="最近记忆活动" layout="stacked">
          <ul className={styles.memoryList} aria-label="最近记忆活动">
            {activities.map((activity, index) => (
              <li key={`${activity.kind}-${activity.at ?? index}-${index}`}>
                {activityText(activity)}
                {activity.at === undefined ? '' : ` · ${relativeTime(activity.at)}`}
              </li>
            ))}
          </ul>
        </PropertyRow>
      ) : null}
    </PropertyList>
  )
}
