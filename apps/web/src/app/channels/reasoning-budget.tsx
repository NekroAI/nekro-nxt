import { HostApiContracts, type HostApiResponse } from '@nekro-nxt/contracts'
import { ChevronDown, RotateCcw, Zap } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { callHostApi } from '../../host-api-client.js'
import { reasoningLabel } from '../../reasoning-label.js'
import { DampedSlider, Popover, Pressable, toast } from '../../ui-kit/index.js'
import styles from './reasoning-budget.module.css'

type View = HostApiResponse<'getChannelReasoning'>

export function ReasoningBudget({ channelId, modelKey }: { readonly channelId: string; readonly modelKey: string }) {
  const [view, setView] = useState<View>()
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<number>()
  const [pageVisible, setPageVisible] = useState(true)
  const inFlight = useRef(false)
  const generation = useRef(0)
  useEffect(() => {
    if (!open) return
    const update = () => setPageVisible(document.visibilityState === 'visible')
    update()
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [open])
  const load = async (signal?: AbortSignal) => {
    const current = ++generation.current
    setLoading(true)
    try {
      const next = await callHostApi(
        HostApiContracts.getChannelReasoning,
        { channelId },
        undefined,
        signal ? { signal } : {},
      )
      if (signal?.aborted || current !== generation.current) return
      setView(next)
      setPreview(undefined)
      setFailed(false)
    } catch {
      if (!signal?.aborted && current === generation.current) setFailed(true)
    } finally {
      if (!signal?.aborted && current === generation.current) setLoading(false)
    }
  }
  useEffect(() => {
    const controller = new AbortController()
    setView(undefined)
    setOpen(false)
    void load(controller.signal)
    return () => {
      controller.abort()
      generation.current++
    }
  }, [channelId, modelKey])

  const efforts = view?.reasoning?.efforts ?? []
  if (failed && !view)
    return (
      <Pressable type="button" className={styles.trigger} onClick={() => void load()}>
        重试读取思考预算
      </Pressable>
    )
  if (!view || efforts.length === 0) return null
  const savedIndex = efforts.findIndex((effort) => effort.id === view.effectiveEffort)
  const index = preview ?? Math.max(0, savedIndex)
  const selected = efforts[index]!
  const label = preview !== undefined || savedIndex >= 0 ? reasoningLabel(selected) : '默认'
  const ultra = selected.id === 'max'
  const save = async (effort: string | null) => {
    if (inFlight.current || effort === view.effort) {
      setPreview(undefined)
      return
    }
    inFlight.current = true
    setSaving(true)
    generation.current++
    try {
      const next = await callHostApi(
        HostApiContracts.updateChannelReasoning,
        { channelId },
        {
          provider: view.provider,
          model: view.model,
          effort,
          expectedRevision: view.revision,
        },
      )
      setView(next)
      setFailed(false)
    } catch (error) {
      toast(error instanceof Error ? error.message : '思考预算保存失败，请重试。', {
        tone: 'bad',
        group: `reasoning:${channelId}`,
      })
      await load()
    } finally {
      setPreview(undefined)
      setSaving(false)
      inFlight.current = false
    }
  }
  const commit = (value: number) => void save(efforts[value]!.id)
  return (
    <Popover
      label="思考预算"
      align="start"
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next && !inFlight.current) void load()
      }}
      className={styles.popover}
      trigger={
        <Pressable type="button" className={styles.trigger} aria-label={`思考预算：${label}`}>
          <Zap aria-hidden="true" />
          <span>{label}</span>
          <ChevronDown aria-hidden="true" />
        </Pressable>
      }
    >
      <div className={styles.budget} data-ultra={ultra || undefined} aria-busy={saving || loading}>
        <div className={styles.header}>
          <Zap className={styles.bolt} aria-hidden="true" />
          <div className={styles.heading}>
            <strong aria-live="polite">{label}</strong>
            <span title={view.modelName}>{view.modelName}</span>
          </div>
          <Pressable
            type="button"
            className={styles.reset}
            aria-label="恢复默认思考预算"
            title="恢复默认思考预算"
            disabled={saving || loading || view.effort === null}
            onClick={() => void save(null)}
          >
            <RotateCcw aria-hidden="true" />
          </Pressable>
        </div>
        <div className={styles.track}>
          <DampedSlider
            label="思考预算"
            valueText={label}
            max={efforts.length - 1}
            value={index}
            showMarks={!ultra}
            disabled={saving || loading}
            onValueChange={setPreview}
            onValueCommit={commit}
            onValueCancel={() => setPreview(undefined)}
          >
            <span className={styles.ultra} data-part="ultra" data-running={(ultra && open && pageVisible) || undefined}>
              <span className={styles.particles} data-part="particles">
                <i />
                <i />
              </span>
            </span>
          </DampedSlider>
        </div>
        <div className={styles.caption} role="status">
          {saving
            ? '正在保存…'
            : failed
              ? '读取失败，重新打开以重试'
              : view.effort === null
                ? '使用默认预算'
                : '仅此对话'}
        </div>
      </div>
    </Popover>
  )
}
