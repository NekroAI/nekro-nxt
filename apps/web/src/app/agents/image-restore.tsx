import type { DraftUpdate, ImageRestorePolicy } from './agent-draft.js'
import { PropertyRow, Select } from '../../ui-kit/index.js'
import styles from './image-restore.module.css'

const IMAGE_COUNTS = [0, 4, 8, 12, 20, 30]
const MESSAGE_WINDOWS = [16, 32, 64, 100]

/** Presets plus whatever is saved now, so an older value still shows as itself. */
const choices = (presets: readonly number[], current: number, label: (value: number) => string) =>
  [...new Set([...presets, current])]
    .sort((left, right) => left - right)
    .map((value) => ({
      value: String(value),
      label: label(value),
    }))

/**
 * How many recent images go back into the conversation after compaction turns older messages into a text summary.
 * Group chats move on quickly, so a few recent pictures keep the current scene readable; older ones the agent can
 * look up itself.
 */
export function ImageRestoreRow({
  value,
  update,
}: {
  readonly value: ImageRestorePolicy
  readonly update: DraftUpdate
}) {
  const set = (patch: Partial<ImageRestorePolicy>) =>
    update((current) => ({ ...current, imageRestore: { ...current.imageRestore, ...patch } }))
  return (
    <PropertyRow
      label="压缩后附回图片"
      layout="stacked"
      tip="压缩会把较早的消息整理成文字，图片也随之移出上下文。附回最近的几张图，它能接着看懂刚才在聊什么；更早的图需要时它会自己回去查看。"
      description={
        value.maxImages === 0
          ? '压缩后只留文字摘要'
          : `压缩后从最近 ${value.recentMessages} 条消息里附回最多 ${value.maxImages} 张图片`
      }
    >
      <div className={styles.controls}>
        <Select
          aria-label="附回图片数量"
          value={String(value.maxImages)}
          options={choices(IMAGE_COUNTS, value.maxImages, (count) => (count === 0 ? '不附回' : `最多 ${count} 张`))}
          onValueChange={(next) => set({ maxImages: Number(next) })}
        />
        <Select
          aria-label="附回图片的消息范围"
          value={String(value.recentMessages)}
          disabled={value.maxImages === 0}
          options={choices(MESSAGE_WINDOWS, value.recentMessages, (count) => `最近 ${count} 条消息`)}
          onValueChange={(next) => set({ recentMessages: Number(next) })}
        />
      </div>
    </PropertyRow>
  )
}
