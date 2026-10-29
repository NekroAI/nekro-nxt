import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  DataTable,
  IconButton,
  Input,
  SearchField,
  Switch,
  ToggleChip,
  toast,
  type Column,
} from './ui-kit/index.js'
import styles from './llm-settings.module.css'

export interface EditableModel {
  readonly id: string
  readonly name?: string | undefined
  readonly contextWindow?: number | undefined
  readonly maxTokens?: number | undefined
  readonly inputModalities?: ('text' | 'image')[] | undefined
  /** Thinking levels the model offers; carried along, not edited in the table. */
  readonly reasoningEfforts?: string[] | undefined
}

/** One editable model row; numeric fields stay as typed text until the row is submitted. */
export interface ModelRow {
  readonly key: string
  readonly id: string
  readonly name: string
  readonly contextWindow: string
  readonly maxTokens: string
  readonly image: boolean
  readonly reasoningEfforts?: readonly string[]
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
  ...(model.reasoningEfforts?.length ? { reasoningEfforts: [...model.reasoningEfforts] } : {}),
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
      ...(row.reasoningEfforts?.length ? { reasoningEfforts: [...row.reasoningEfforts] } : {}),
    }
  })

/**
 * Listed models the discovery describes better: thinking levels the row lacks, and a context length left empty.
 * What the person set in the table is kept.
 */
export const enrichRows = (rows: readonly ModelRow[], discovered: readonly EditableModel[]): ModelRow[] =>
  rows.map((row) => {
    const found = discovered.find((model) => model.id === row.id.trim())
    if (!found) return row
    return {
      ...row,
      ...(!row.reasoningEfforts?.length && found.reasoningEfforts?.length
        ? { reasoningEfforts: [...found.reasoningEfforts] }
        : {}),
      ...(!row.contextWindow && found.contextWindow !== undefined
        ? { contextWindow: String(found.contextWindow) }
        : {}),
    }
  })

/** Discovered models not yet in the list, in discovery order; an id the provider repeats is offered once. */
export const modelsToAdd = (rows: readonly ModelRow[], discovered: readonly EditableModel[]): EditableModel[] => {
  const seen = new Set(rows.map((row) => row.id.trim()))
  return discovered.filter((model) => {
    if (seen.has(model.id)) return false
    seen.add(model.id)
    return true
  })
}

/** Whether a model id or display name contains every space-separated word of the query, ignoring case. */
export const matchesModelQuery = (query: string, id: string, name?: string): boolean => {
  const words = query.trim().toLowerCase().split(/\s+/u).filter(Boolean)
  if (words.length === 0) return true
  const text = `${id} ${name ?? ''}`.toLowerCase()
  return words.every((word) => text.includes(word))
}

/** Rows with the chosen models appended; models whose id is already listed are skipped and counted. */
export const appendModels = (
  rows: readonly ModelRow[],
  models: readonly EditableModel[],
): { readonly rows: readonly ModelRow[]; readonly added: number; readonly skipped: number } => {
  const fresh = modelsToAdd(rows, models)
  return {
    rows: [...rows, ...fresh.map(modelRowFromModel)],
    added: fresh.length,
    skipped: models.length - fresh.length,
  }
}

/** Lists longer than this show search and bulk selection. */
export const BULK_TOOLS_FROM = 10
/** Most matches drawn at once; long catalogs ask for a narrower search instead. */
export const SHOWN_MATCHES = 200
const NARROW_HINT = `只显示前 ${SHOWN_MATCHES} 个，输入关键词缩小范围。`

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
 * The error worth showing right now. Rows the user has not touched yet (for example the blank row "添加模型" just
 * appended) only count once the form was submitted, so adding a row never greets the user with a complaint.
 */
export const visibleModelRowsError = (
  rows: readonly ModelRow[],
  touched: ReadonlySet<string>,
  options: { readonly revealAll: boolean; readonly listTouched: boolean },
): string | undefined => {
  if (options.revealAll) return modelRowsError(rows)
  if (rows.length === 0) return options.listTouched ? modelRowsError(rows) : undefined
  const relevant = rows.filter((row) => touched.has(row.key) || row.id.trim() !== '')
  return relevant.length > 0 ? modelRowsError(relevant) : undefined
}

/** A row or "all matching rows" checkbox; `mixed` draws the partly selected state. */
function SelectBox({
  label,
  checked,
  mixed = false,
  disabled,
  onChange,
}: {
  readonly label: string
  readonly checked: boolean
  readonly mixed?: boolean
  readonly disabled: boolean
  readonly onChange: (checked: boolean) => void
}): ReactNode {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed
  }, [mixed])
  return (
    <input
      ref={ref}
      type="checkbox"
      className={styles.selectBox}
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
  )
}

const notifyAdded = (added: number, skipped: number): void => {
  const skippedText = skipped > 0 ? `，跳过 ${skipped} 个已在列表中的模型` : ''
  toast(`已加入 ${added} 个模型${skippedText}，保存后生效。`, { group: 'llm-model-add' })
}

/**
 * Discovered models the list does not have yet. Nothing is added until the person picks: chips toggle a selection that
 * survives a new search, and "全部加入" takes every current match. Only the first matches are drawn.
 */
function ModelCandidates({
  rows,
  addable,
  disabled,
  onChange,
}: {
  readonly rows: readonly ModelRow[]
  readonly addable: readonly EditableModel[]
  readonly disabled: boolean
  readonly onChange: (rows: readonly ModelRow[]) => void
}): ReactNode {
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set())
  const matches = useMemo(
    () => addable.filter((model) => matchesModelQuery(query, model.id, model.name)),
    [addable, query],
  )
  // Picks the list gained in the meantime, or a refresh no longer offers, drop out of the selection.
  const selected = addable.filter((model) => chosen.has(model.id))
  const add = (models: readonly EditableModel[]): void => {
    const next = appendModels(rows, models)
    onChange(next.rows)
    setChosen(new Set())
    notifyAdded(next.added, next.skipped)
  }
  const toggle = (id: string, on: boolean): void => {
    const next = new Set(chosen)
    if (on) next.add(id)
    else next.delete(id)
    setChosen(next)
  }
  return (
    <div className={styles.discovered}>
      <div className={styles.discoveredHead}>
        <span>供应商提供、尚未加入的模型（{addable.length}）</span>
      </div>
      <div className={styles.listTools}>
        <SearchField value={query} onChange={setQuery} label="搜索可加入的模型" placeholder="搜索模型 ID 或名称" />
        <div className={styles.listActions}>
          {selected.length > 0 ? (
            <Button size="small" variant="ghost" disabled={disabled} onClick={() => setChosen(new Set())}>
              取消选择
            </Button>
          ) : null}
          <Button size="small" disabled={disabled || selected.length === 0} onClick={() => add(selected)}>
            加入所选（{selected.length}）
          </Button>
          <Button
            size="small"
            disabled={disabled || matches.length === 0}
            onClick={() => {
              add(matches)
              setQuery('')
            }}
          >
            全部加入（{matches.length}）
          </Button>
        </div>
      </div>
      {matches.length === 0 ? (
        <p className={styles.muted}>没有匹配的模型</p>
      ) : (
        <div className={styles.chipList} role="group" aria-label="可加入的模型">
          {matches.slice(0, SHOWN_MATCHES).map((model) => (
            <ToggleChip
              key={model.id}
              pressed={chosen.has(model.id)}
              onPressedChange={(on) => {
                if (!disabled) toggle(model.id, on)
              }}
            >
              {model.id}
              {model.name && model.name !== model.id ? ` · ${model.name}` : ''}
              {model.inputModalities?.includes('image') ? ' · 视觉' : ''}
            </ToggleChip>
          ))}
        </div>
      )}
      {matches.length > SHOWN_MATCHES ? <p className={styles.muted}>{NARROW_HINT}</p> : null}
    </div>
  )
}

/**
 * Editable model catalog of one provider. Narrow containers drop the display name and output columns first; the id,
 * context size and image switch always stay. Long lists gain a search box and bulk selection. Every edit, bulk
 * deletes included, takes effect only when the provider is saved.
 */
export function ModelListEditor({
  rows,
  onChange,
  discovered,
  disabled = false,
  validate,
  revealErrors = false,
}: {
  readonly rows: readonly ModelRow[]
  readonly onChange: (rows: readonly ModelRow[]) => void
  readonly discovered: readonly EditableModel[]
  readonly disabled?: boolean
  /** Whether the rows are checked at all (an untouched catalog that will not be submitted is not). */
  readonly validate: boolean
  /** True once the user tried to save: every row counts, touched or not. */
  readonly revealErrors?: boolean
}): ReactNode {
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set())
  const [listTouched, setListTouched] = useState(false)
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set())
  // Rows added by hand, and rows edited under the current search, stay in view even when they stop matching.
  const [added, setAdded] = useState<ReadonlySet<string>>(() => new Set())
  const [edited, setEdited] = useState<ReadonlySet<string>>(() => new Set())
  const pinned = (key: string): boolean => added.has(key) || edited.has(key)
  const touch = (key: string): void => {
    if (!touched.has(key)) setTouched(new Set([...touched, key]))
  }
  const update = (key: string, patch: Partial<Omit<ModelRow, 'key'>>): void => {
    touch(key)
    if (query && !edited.has(key)) setEdited(new Set([...edited, key]))
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }
  const error = validate ? visibleModelRowsError(rows, touched, { revealAll: revealErrors, listTouched }) : undefined
  const addable = useMemo(() => modelsToAdd(rows, discovered), [rows, discovered])
  const bulk = rows.length >= BULK_TOOLS_FROM
  const matches = bulk ? rows.filter((row) => pinned(row.key) || matchesModelQuery(query, row.id, row.name)) : rows
  const shown = bulk ? matches.filter((row, index) => index < SHOWN_MATCHES || pinned(row.key)) : rows
  const selected = rows.filter((row) => chosen.has(row.key))
  const matchesSelected = matches.filter((row) => chosen.has(row.key)).length
  const search = (next: string): void => {
    setQuery(next)
    setEdited(new Set())
  }
  const select = (keys: readonly string[], on: boolean): void => {
    const next = new Set(chosen)
    for (const key of keys) {
      if (on) next.add(key)
      else next.delete(key)
    }
    setChosen(next)
  }
  const removeSelected = (): void => {
    setListTouched(true)
    setChosen(new Set())
    onChange(rows.filter((row) => !chosen.has(row.key)))
    toast(`已删除 ${selected.length} 个模型，保存后生效。`, { group: 'llm-model-remove' })
  }
  const selectColumn: Column<ModelRow> = {
    key: 'select',
    header: (
      <SelectBox
        label="选择全部匹配的模型"
        checked={matches.length > 0 && matchesSelected === matches.length}
        mixed={matchesSelected > 0 && matchesSelected < matches.length}
        disabled={disabled || matches.length === 0}
        onChange={(on) =>
          select(
            matches.map((row) => row.key),
            on,
          )
        }
      />
    ),
    width: '32px',
    align: 'center',
    render: (row) => (
      <SelectBox
        label={`选择模型 ${label(row)}`}
        checked={chosen.has(row.key)}
        disabled={disabled}
        onChange={(on) => select([row.key], on)}
      />
    ),
  }
  const columns: readonly Column<ModelRow>[] = [
    ...(bulk ? [selectColumn] : []),
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
          onBlur={() => touch(row.key)}
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
      header: '视觉',
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
          onClick={() => {
            setListTouched(true)
            onChange(rows.filter((candidate) => candidate.key !== row.key))
          }}
        >
          <Trash2 size={14} aria-hidden="true" />
        </IconButton>
      ),
    },
  ]
  return (
    <div className={styles.modelEditor}>
      {bulk ? (
        <div className={styles.listTools}>
          <SearchField value={query} onChange={search} label="搜索模型列表" placeholder="搜索模型 ID 或名称" />
          {selected.length > 0 ? (
            <div className={styles.listActions}>
              <span className={styles.muted}>已选 {selected.length} 个</span>
              <Button size="small" variant="ghost" disabled={disabled} onClick={() => setChosen(new Set())}>
                取消选择
              </Button>
              <Button
                size="small"
                variant="danger"
                icon={<Trash2 size={14} aria-hidden="true" />}
                disabled={disabled}
                onClick={removeSelected}
              >
                删除所选
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      <DataTable
        label="模型列表"
        columns={columns}
        rows={shown}
        rowKey={(row) => row.key}
        empty={rows.length === 0 ? '还没有模型' : '没有匹配的模型'}
        footer={
          <>
            <span>
              {query && bulk ? `匹配 ${matches.length} 个，共 ${rows.length} 个模型` : `${rows.length} 个模型`}
            </span>
            <Button
              size="small"
              icon={<Plus size={14} aria-hidden="true" />}
              disabled={disabled}
              onClick={() => {
                const row = emptyModelRow()
                setAdded(new Set([...added, row.key]))
                onChange([...rows, row])
              }}
            >
              添加模型
            </Button>
          </>
        }
      />
      {matches.length > shown.length ? <p className={styles.muted}>{NARROW_HINT}</p> : null}
      {error ? (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      ) : null}
      {addable.length > 0 ? (
        <ModelCandidates rows={rows} addable={addable} disabled={disabled} onChange={onChange} />
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
      header: '视觉',
      width: '72px',
      align: 'center',
      render: (model) => (model.inputModalities?.includes('image') ? '支持' : '—'),
    },
  ]
  return <DataTable label="模型列表" columns={columns} rows={models} rowKey={(model) => model.id} empty="没有模型" />
}
