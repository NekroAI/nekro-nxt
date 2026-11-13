/** @jsxImportSource preact */
import { useRef, useState } from 'preact/hooks'
import { useClock } from './clock.js'
import type { ChatData, Mode } from './types.js'

const LEAD = 400
const READ = 900
const TYPING = 1100
const AFTER_REPLY = 700
const END = 1600

/**
 * When each message and reply appears in one mode, as a function of time (see useClock): a message, a beat, and her
 * reply after a moment of typing when she answers it.
 */
export const chatTimeline = (data: ChatData, mode: string) => {
  let time = LEAD
  const shown = data.messages.map((message) => {
    const at = time
    const reply = message.replies[mode]
    time += READ
    if (reply === undefined) return { at, reply: null }
    const typing = time
    time += TYPING
    const replied = time
    time += AFTER_REPLY
    return { at, reply: { text: reply, typing, at: replied } }
  })
  return { shown, total: time + END }
}

/** The overview animation plays the chat once in every mode, so the GIF shows the difference; it ends on the first. */
export const chatCycle = (data: ChatData) => {
  const modes = data.modes.length === 0 ? [''] : data.modes.map((item) => item.id)
  const lengths = modes.map((item) => chatTimeline(data, item).total)
  return { modes, lengths, total: lengths.reduce((sum, length) => sum + length, 0) }
}

/** Which mode and moment a poster shows: `mode-<id>` holds that mode finished; `overview` follows chatCycle. */
const posterFrame = (data: ChatData, state: string, time: number) => {
  const named = /^mode-(.+)$/u.exec(state)?.[1]
  if (named !== undefined) return { mode: named, time }
  const cycle = chatCycle(data)
  let rest = time
  for (const [index, length] of cycle.lengths.entries()) {
    if (rest < length) return { mode: cycle.modes[index] ?? '', time: rest }
    rest -= length
  }
  return { mode: cycle.modes[0] ?? '', time: Number.POSITIVE_INFINITY }
}

/**
 * 聊天回放: a made-up group chat that plays message by message. With modes, a switch above it replays the chat in
 * another mode, and a message she answers in another mode but not this one is marked, since that is the difference.
 * A poster `mode-<id>` holds that mode finished; `overview` is the first mode, or a moment of the cycle while animating.
 */
export const Chat = ({ title, data, mode }: { title: string; data: ChatData; mode: Mode }) => {
  const root = useRef<HTMLElement>(null)
  const [picked, setPicked] = useState(data.modes[0]?.id ?? '')
  const poster = mode.kind === 'poster' ? posterFrame(data, mode.state, mode.time) : undefined
  const active = poster?.mode ?? picked
  const timeline = chatTimeline(data, active)
  const clock = useClock(mode, timeline.total, true, root)
  const { control, restart } = clock
  const time = poster?.time ?? clock.time
  const activeMode = data.modes.find((item) => item.id === active)
  // The last character, since group names often share the first (小林, 小荧).
  const initial = (name: string) => [...name].at(-1) ?? '?'

  return (
    <figure ref={root} class="card" style={{ margin: 0 }} aria-label={`聊天回放：${title}`}>
      <div class="head">
        <p class="title">
          <span class="kind">聊天回放</span>
          {title}
        </p>
        {control === null ? null : (
          <button type="button" class="control" onClick={control.toggle}>
            {control.label}
          </button>
        )}
      </div>
      {data.modes.length === 0 ? null : (
        <div class="modes">
          <div class="segmented" role="radiogroup" aria-label="触发方式">
            {data.modes.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={item.id === active}
                class={item.id === active ? 'on' : ''}
                onClick={() => {
                  setPicked(item.id)
                  restart()
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
          {activeMode?.note === undefined ? null : <p class="mode-note">{activeMode.note}</p>}
        </div>
      )}
      <ol class="chat" aria-live="polite">
        {data.messages.map((message, index) => {
          const moment = timeline.shown[index]
          if (moment === undefined) return null
          const reply = moment.reply
          const missed = reply === null && data.modes.some((item) => message.replies[item.id] !== undefined)
          // Everything is laid out from the start and shown in turn, so the chat does not jump as it plays.
          return (
            <li key={`${active}-${index}`} class="turn">
              <div class={`message${time >= moment.at ? ' in' : ''}`}>
                <span class="avatar" aria-hidden="true">
                  {initial(message.from)}
                </span>
                <div class="said">
                  <span class="who">{message.from}</span>
                  <p class="bubble">{message.text}</p>
                  {missed && activeMode !== undefined ? (
                    <span class="quiet">{activeMode.label}：她不回这条</span>
                  ) : null}
                </div>
              </div>
              {reply === null ? null : (
                <div class={`message agent${time >= reply.at ? ' in' : time >= reply.typing ? ' typing' : ''}`}>
                  <span class="avatar" aria-hidden="true">
                    {initial(data.agent)}
                  </span>
                  <div class="said">
                    <span class="who">{data.agent}</span>
                    <p class="bubble">{reply.text}</p>
                    <span class="typing-dots" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ol>
    </figure>
  )
}
