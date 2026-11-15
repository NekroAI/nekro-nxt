import type { AgentSummary, ModelSummary } from '../../product-model.js'
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

const REQUEST_IMAGE_LIMITS = [6, 8, 12, 16, 24, 32]
/** What the hint suggests for routes that send every image again with each reply. */
export const SUGGESTED_REQUEST_IMAGES = 8

/** How a main model sends images already in the conversation, as the host reports it. */
export type RequestImageTransport = 'uploaded' | 'resent' | 'unknown'

/**
 * How the draft's main model sends images: its kind of route, and, while it is still the saved main model, also
 * whether a recent request had to send every image again anyway.
 */
export const draftRequestImages = (
  model: Pick<ModelSummary, 'provider' | 'id' | 'requestImages'>,
  agent: Pick<AgentSummary, 'modelRef' | 'imageDiagnostics'> | undefined,
): RequestImageTransport | undefined => {
  const saved =
    agent?.modelRef?.provider === model.provider && agent.modelRef.model === model.id
      ? agent.imageDiagnostics?.requestImages
      : undefined
  // The saved model's report already folds the route together with what its recent requests did.
  return saved ?? model.requestImages
}

/**
 * The most images one reply sends to the model. Routes that cannot reuse uploaded files send every image again with
 * each reply, so a long run of pictures makes every reply slower; past the limit the oldest ones become placeholders
 * the agent can still open.
 */
export function RequestImageLimitRow({
  value,
  transport,
  update,
}: {
  readonly value: number | undefined
  /** Undefined when the host does not say. */
  readonly transport: RequestImageTransport | undefined
  readonly update: DraftUpdate
}) {
  const hinted =
    (transport === 'resent' || transport === 'unknown') && (value === undefined || value > SUGGESTED_REQUEST_IMAGES)
  return (
    <PropertyRow
      label="单次请求图片上限"
      layout="stacked"
      tip="每次回复都会把对话里的图片一起发给模型。超过上限时，最早的几张换成占位文字，智能体需要时会重新查看。"
      description={
        hinted
          ? `${transport === 'resent' ? '当前主模型' : '当前主模型可能'}每次回复都要重新发送全部图片，图片多时回复会变慢，建议设为 ${SUGGESTED_REQUEST_IMAGES} 张。`
          : undefined
      }
    >
      <div className={styles.controls}>
        <Select
          aria-label="单次请求图片上限"
          value={String(value ?? 0)}
          options={choices([0, ...REQUEST_IMAGE_LIMITS], value ?? 0, (count) =>
            count === 0 ? '不限制' : `最多 ${count} 张`,
          )}
          onValueChange={(next) =>
            update((current) => ({ ...current, maxRequestImages: next === '0' ? undefined : Number(next) }))
          }
        />
      </div>
    </PropertyRow>
  )
}
