import { Plus, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button, IconButton, Input, SwitchControl } from './ui-kit/index.js'
import styles from './llm-settings.module.css'

export interface EditableModel {
  readonly id: string
  readonly name?: string | undefined
  readonly contextWindow?: number | undefined
  readonly maxTokens?: number | undefined
  readonly inputModalities?: ('text' | 'image')[] | undefined
}

/** One editable model row; numeric fields stay as typed text until the row is submitted. */
export interface ModelRow {
  readonly key: string
  readonly id: string
  readonly name: string
  readonly contextWindow: string
  readonly maxTokens: string
  readonly image: boolean
}

let nextRowKey = 0
const rowKey = (): string => `model-row-${(nextRowKey += 1)}`

export const modelRowFromModel = (model: EditableModel): ModelRow => ({
  key: rowKey(),
  id: model.id,
  name: model.name && model.name !== model.id ? model.name : '',
  contextWindow: model.contextWindow === undefined ? '' : String(model.contextWindow),
  maxTokens: model.maxTokens === undefined ? '' : String(model.maxTokens),
  image: model.inputModalities?.includes('image') === true,
})

export const emptyModelRow = (): ModelRow => ({
  key: rowKey(),
  id: '',
  name: '',
  contextWindow: '',
  maxTokens: '',
  image: false,
})

const positiveInteger = (value: string): number | undefined | null => {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

/** Why the current rows cannot be saved, or undefined when they can. */
export const modelRowsError = (rows: readonly ModelRow[]): string | undefined => {
  if (rows.length === 0) return '请至少添加一个模型。'
  const ids = rows.map((row) => row.id.trim())
  if (ids.some((id) => !id)) return '模型 ID 不能为空。'
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index)
  if (duplicate) return `模型 ID ${duplicate} 重复。`
  const invalid = rows.find(
    (row) => positiveInteger(row.contextWindow) === null || positiveInteger(row.maxTokens) === null,
  )
  if (invalid) return `模型 ${invalid.id.trim()} 的上下文长度和最大输出需要填写正整数。`
  return undefined
}

/** Submitted model entries; the image switch always states the modalities explicitly. */
export const modelPayload = (rows: readonly ModelRow[]): EditableModel[] =>
  rows.map((row) => {
    const contextWindow = positiveInteger(row.contextWindow)
    const maxTokens = positiveInteger(row.maxTokens)
    return {
      id: row.id.trim(),
      ...(row.name.trim() ? { name: row.name.trim() } : {}),
      ...(typeof contextWindow === 'number' ? { contextWindow } : {}),
      ...(typeof maxTokens === 'number' ? { maxTokens } : {}),
      inputModalities: row.image ? ['text', 'image'] : ['text'],
    }
  })

/** Discovered models not yet in the list, in discovery order. */
export const modelsToAdd = (rows: readonly ModelRow[], discovered: readonly EditableModel[]): EditableModel[] => {
  const present = new Set(rows.map((row) => row.id.trim()))
  return discovered.filter((model) => !present.has(model.id))
}

export function ModelListEditor({
  rows,
  onChange,
  discovered,
  disabled = false,
  error,
}: {
  readonly rows: readonly ModelRow[]
  readonly onChange: (rows: readonly ModelRow[]) => void
  readonly discovered: readonly EditableModel[]
  readonly disabled?: boolean
  readonly error?: string | undefined
}): ReactNode {
  const update = (key: string, patch: Partial<Omit<ModelRow, 'key'>>): void =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  const addable = modelsToAdd(rows, discovered)
  return (
    <div className={styles.modelEditor}>
      <div className={styles.modelTable} role="table" aria-label="模型列表">
        <div className={styles.modelHeaderRow} role="row">
          <span role="columnheader">模型 ID</span>
          <span role="columnheader">显示名</span>
          <span role="columnheader">上下文长度</span>
          <span role="columnheader">最大输出</span>
          <span role="columnheader">支持图片</span>
          <span role="columnheader" aria-label="操作" />
        </div>
        {rows.map((row) => (
          <div className={styles.modelRow} role="row" key={row.key}>
            <Input
              aria-label="模型 ID"
              value={row.id}
              disabled={disabled}
              placeholder="例如 deepseek-flash"
              onChange={(event) => update(row.key, { id: event.target.value })}
            />
            <Input
              aria-label={`${row.id || '新模型'}的显示名`}
              value={row.name}
              disabled={disabled}
              placeholder="可选"
              onChange={(event) => update(row.key, { name: event.target.value })}
            />
            <Input
              aria-label={`${row.id || '新模型'}的上下文长度`}
              inputMode="numeric"
              value={row.contextWindow}
              disabled={disabled}
              placeholder="默认"
              onChange={(event) => update(row.key, { contextWindow: event.target.value })}
            />
            <Input
              aria-label={`${row.id || '新模型'}的最大输出`}
              inputMode="numeric"
              value={row.maxTokens}
              disabled={disabled}
              placeholder="默认"
              onChange={(event) => update(row.key, { maxTokens: event.target.value })}
            />
            <span className={styles.modelSwitch}>
              <SwitchControl
                label={`${row.id || '新模型'}支持图片输入`}
                checked={row.image}
                disabled={disabled}
                onCheckedChange={(image) => update(row.key, { image })}
              />
            </span>
            <IconButton
              label={`删除模型 ${row.id || '新模型'}`}
              disabled={disabled}
              onClick={() => onChange(rows.filter((candidate) => candidate.key !== row.key))}
            >
              <Trash2 size={14} aria-hidden="true" />
            </IconButton>
          </div>
        ))}
      </div>
      {error ? (
        <p className={styles.modelError} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.modelToolbar}>
        <Button size="small" disabled={disabled} onClick={() => onChange([...rows, emptyModelRow()])}>
          <Plus size={14} aria-hidden="true" /> 添加模型
        </Button>
      </div>
      {addable.length > 0 ? (
        <div className={styles.discoveredModels}>
          <div className={styles.modelToolbar}>
            <span className={styles.fieldLabel}>供应商提供、尚未加入的模型（{addable.length}）</span>
            <Button
              size="small"
              disabled={disabled}
              onClick={() => onChange([...rows, ...addable.map(modelRowFromModel)])}
            >
              全部加入
            </Button>
          </div>
          <div className={styles.modelList}>
            {addable.map((model) => (
              <Button
                size="small"
                variant="ghost"
                key={model.id}
                disabled={disabled}
                onClick={() => onChange([...rows, modelRowFromModel(model)])}
              >
                <Plus size={12} aria-hidden="true" /> {model.id}
                {model.name && model.name !== model.id ? ` · ${model.name}` : ''}
                {model.inputModalities?.includes('image') ? ' · 图片' : ''}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
