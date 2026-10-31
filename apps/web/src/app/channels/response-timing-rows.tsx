import { useEffect, useState } from 'react'
import {
  RESPONSE_TIMING_LIMITS,
  resolveResponseTiming,
  type ResolvedResponseTiming,
  type ResponseTimingSettings,
} from '@nekro-nxt/contracts'
import { Button, Input, PropertyRow, Switch } from '../../ui-kit/index.js'
import type { TriggerPolicy } from '../model/identity.js'
import styles from './channels.module.css'

type NumericKey = keyof typeof RESPONSE_TIMING_LIMITS

/** A whole number of seconds (or messages) saved when the field loses focus; out-of-range input snaps to the bound. */
function NumberSetting({
  label,
  value,
  field,
  unit,
  onSave,
}: {
  readonly label: string
  readonly value: number
  readonly field: NumericKey
  readonly unit: string
  readonly onSave: (value: number) => void
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const { min, max } = RESPONSE_TIMING_LIMITS[field]
  const save = () => {
    const parsed = Number.parseInt(text, 10)
    const next = Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : value
    setText(String(next))
    if (next !== value) onSave(next)
  }
  return (
    <div className={styles.unitField}>
      <Input
        aria-label={label}
        type="number"
        min={min}
        max={max}
        step={1}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.blur()
          }
        }}
      />
      <span aria-hidden="true">{unit}</span>
    </div>
  )
}

/**
 * When the bound agent speaks (Decision 2026-10-31 响应时机与智能响应): waiting for someone to finish, for every
 * policy that answers messages, and the extra wakes of smart mode.
 */
export function ResponseTimingRows({
  triggerPolicy,
  settings,
  onChange,
}: {
  readonly triggerPolicy: TriggerPolicy
  readonly settings: ResponseTimingSettings
  readonly onChange: (next: ResponseTimingSettings) => void
}) {
  if (triggerPolicy === 'command' || triggerPolicy === 'observe-only') return null
  const resolved = resolveResponseTiming(settings)
  const set = <K extends keyof ResolvedResponseTiming>(key: K, value: ResolvedResponseTiming[K]) =>
    onChange({ ...settings, [key]: value })
  const number = (key: NumericKey, label: string, unit = '秒') => (
    <NumberSetting label={label} value={resolved[key]} field={key} unit={unit} onSave={(value) => set(key, value)} />
  )
  const smart = triggerPolicy === 'smart'
  return (
    <>
      <PropertyRow
        label="等对方说完"
        description="对方话没说完时先不回，等他停下来再一起回复"
        tip="智能体觉得对方还没说完时会先结束这一轮，对方安静一会儿后再叫醒它；这时它必须回复。每次等多久由智能体在下面的上限内决定。"
      >
        <Switch label="等对方说完" checked={resolved.waitEnabled} onCheckedChange={(on) => set('waitEnabled', on)} />
      </PropertyRow>
      {resolved.waitEnabled ? (
        <>
          <PropertyRow label="每次最多等" depth={1}>
            {number('waitMaxQuietSeconds', '每次最多等（秒）')}
          </PropertyRow>
          <PropertyRow label="一共最多等" depth={1} tip="从第一次等这个人算起，到时间就直接回复。">
            {number('waitMaxTotalSeconds', '一共最多等（秒）')}
          </PropertyRow>
        </>
      ) : null}
      {smart ? (
        <>
          <PropertyRow
            label="提到名字时"
            description="消息里出现它的名字或别名时叫醒它，它可以不回"
            tip="别名在智能体设置里填写。名字按字面匹配，单字别名容易误触，尽量用两个字以上。"
          >
            <Switch label="提到名字时" checked={resolved.nameWake} onCheckedChange={(on) => set('nameWake', on)} />
          </PropertyRow>
          <PropertyRow label="接着说时" description="刚跟它聊过的人接着说话时叫醒它，它可以不回">
            <Switch
              label="接着说时"
              checked={resolved.attentionWake}
              onCheckedChange={(on) => set('attentionWake', on)}
            />
          </PropertyRow>
          {resolved.attentionWake ? (
            <PropertyRow
              label="聊过后持续"
              depth={1}

              tip="那个人这么久没再说话，就不再因为他接着说而叫醒智能体。"
            >
              {number('attentionSeconds', '聊过后持续（秒）')}
            </PropertyRow>
          ) : null}
          <PropertyRow
            label="合并连发"

            tip="同一个人连着发几条时，等他安静这么久再开始回复，几条一起看；0 表示不等。"
          >
            {number('debounceSeconds', '合并连发（秒）')}
          </PropertyRow>
          {resolved.debounceSeconds > 0 ? (
            <>
              <PropertyRow label="最长合并" depth={1}>
                {number('debounceMaxSeconds', '最长合并（秒）')}
              </PropertyRow>
              <PropertyRow label="最多合并" depth={1}>
                {number('debounceMaxMessages', '最多合并（条）', '条')}
              </PropertyRow>
            </>
          ) : null}
          <PropertyRow label="每分钟最多叫醒" tip="只限制提到名字和接着说这两种；被 @ 或回复时不受限制。">
            {number('midWakesPerMinute', '每分钟最多叫醒（次）', '次')}
          </PropertyRow>
        </>
      ) : null}
      {Object.keys(settings).length > 0 ? (
        <PropertyRow label="响应时机" description="已单独调整过">
          <Button size="small" onClick={() => onChange({})}>
            恢复默认
          </Button>
        </PropertyRow>
      ) : null}
    </>
  )
}
