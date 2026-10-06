import { Plus, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button, DataTable, IconButton, Input, Switch, type Column } from './ui-kit/next/index.js'
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

/** Token counts the way people read them: 1000000 → 100 万, 8192 → 8,192. */
export const formatTokenCount = (value: number | string | undefined): string => {
  const count = typeof value === 'string' ? Number(value.trim()) : value
  if (count === undefined || !Number.isFinite(count) || count <= 0) return ''
  if (count >= 10_000) {
    const tenThousands = count / 10_000
    return `${Number.isInteger(tenThousands) ? tenThousands : tenThousands.toFixed(1)} 万`
  }
  return count.toLocaleString('zh-CN')
}

const label = (row: ModelRow): string => row.id || '新模型'

/**
 * Editable model catalog of one provider. Narrow containers drop the display name and output columns first; the id,
 * context size and image switch always stay.
 */
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
  const columns: readonly Column<ModelRow>[] = [
    {
      key: 'id',
      header: '模型 ID',
      width: 'minmax(180px, 1.8fr)',
      render: (row) => (
        <Input
          aria-label="模型 ID"
          value={row.id}
          disabled={disabled}
          spellCheck={false}
          placeholder="例如 deepseek-flash"
          onChange={(event) => update(row.key, { id: event.target.value })}
        />
      ),
    },
    {
      key: 'name',
      header: '显示名',
      width: 'minmax(120px, 1fr)',
      priority: 2,
      render: (row) => (
        <Input
          aria-label={`${label(row)}的显示名`}
          value={row.name}
          title={row.name || undefined}
          disabled={disabled}
          placeholder="可选"
          onChange={(event) => update(row.key, { name: event.target.value })}
        />
      ),
    },
    {
      key: 'context',
      header: '上下文长度',
      width: 'minmax(140px, 0.9fr)',
      render: (row) => (
        <span className={styles.numberCell}>
          <Input
            aria-label={`${label(row)}的上下文长度`}
            inputMode="numeric"
            value={row.contextWindow}
            disabled={disabled}
            placeholder="默认"
            onChange={(event) => update(row.key, { contextWindow: event.target.value })}
          />
          <span className={styles.numberHint} aria-hidden="true">
            {formatTokenCount(row.contextWindow)}
          </span>
        </span>
      ),
    },
    {
      key: 'output',
      header: '最大输出',
      width: 'minmax(72px, 0.6fr)',
      priority: 3,
      render: (row) => (
        <Input
          aria-label={`${label(row)}的最大输出`}
          inputMode="numeric"
          value={row.maxTokens}
          disabled={disabled}
          placeholder="默认"
          onChange={(event) => update(row.key, { maxTokens: event.target.value })}
        />
      ),
    },
    {
      key: 'image',
      header: '看图',
      width: '48px',
      align: 'center',
      render: (row) => (
        <Switch
          label={`${label(row)}支持图片输入`}
          checked={row.image}
          disabled={disabled}
          onCheckedChange={(image) => update(row.key, { image })}
        />
      ),
    },
    {
      key: 'remove',
      header: <span className={styles.srOnly}>操作</span>,
      width: '32px',
      align: 'end',
      render: (row) => (
        <IconButton
          label={`删除模型 ${label(row)}`}
          size="small"
          disabled={disabled}
          onClick={() => onChange(rows.filter((candidate) => candidate.key !== row.key))}
        >
          <Trash2 size={14} aria-hidden="true" />
        </IconButton>
      ),
    },
  ]
  return (
    <div className={styles.modelEditor}>
      <DataTable
        label="模型列表"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.key}
        empty="还没有模型"
        footer={
          <>
            <span>{rows.length} 个模型</span>
            <Button
              size="small"
              icon={<Plus size={14} aria-hidden="true" />}
              disabled={disabled}
              onClick={() => onChange([...rows, emptyModelRow()])}
            >
              添加模型
            </Button>
          </>
        }
      />
      {error ? (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      ) : null}
      {addable.length > 0 ? (
        <div className={styles.discovered}>
          <div className={styles.discoveredHead}>
            <span>供应商提供、尚未加入的模型（{addable.length}）</span>
            <Button
              size="small"
              disabled={disabled}
              onClick={() => onChange([...rows, ...addable.map(modelRowFromModel)])}
            >
              全部加入
            </Button>
          </div>
          <div className={styles.chipList}>
            {addable.map((model) => (
              <Button
                size="small"
                variant="ghost"
                key={model.id}
                icon={<Plus size={12} aria-hidden="true" />}
                disabled={disabled}
                onClick={() => onChange([...rows, modelRowFromModel(model)])}
              >
                {model.id}
                {model.name && model.name !== model.id ? ` · ${model.name}` : ''}
                {model.inputModalities?.includes('image') ? ' · 看图' : ''}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** Read-only catalog for providers whose models come fixed with their adapter. */
export function ModelListView({ models }: { readonly models: readonly EditableModel[] }): ReactNode {
  const columns: readonly Column<EditableModel>[] = [
    { key: 'name', header: '模型', width: 'minmax(160px, 2fr)', render: (model) => model.name ?? model.id },
    {
      key: 'context',
      header: '上下文长度',
      width: 'minmax(96px, 1fr)',
      priority: 2,
      render: (model) => formatTokenCount(model.contextWindow) || '默认',
    },
    {
      key: 'image',
      header: '看图',
      width: '72px',
      align: 'center',
      render: (model) => (model.inputModalities?.includes('image') ? '支持' : '—'),
    },
  ]
  return <DataTable label="模型列表" columns={columns} rows={models} rowKey={(model) => model.id} empty="没有模型" />
}
