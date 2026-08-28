/// <reference types="vite/client" />

import {
  deletePath,
  getPath,
  rehydrateSchema,
  setPath,
  validateDraft,
  type SchemaNode,
} from '@deepseek-ai/dsh-client-schema-form'
import type { HostApiContract, HostApiRequest, HostApiResponse } from '@nekro-nxt/contracts'
import {
  DshCredentialsChangedSseDataSchema,
  DshPluginOperationSseDataSchema,
  DshSettingsChangedSseDataSchema,
  HostApiContracts,
  HostApiErrorSchema,
  buildHostApiContractPath,
  JsonValueSchema,
  parseJsonValue,
} from '@nekro-nxt/contracts'
import { ChevronDown, ChevronUp, KeyRound, RotateCcw, Trash2, Upload } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { notify } from './components/notifications.js'
import { InlineFeedback } from './components/product-feedback.js'
import { productHostEventStream } from './host-event-stream.js'
import { useProductStore } from './product-store.js'
import { useUnsavedDraft } from './unsaved-drafts.js'
import {
  Button,
  ConfirmDialog,
  Field,
  Input,
  SecretInput,
  SelectField,
  StatusBadge,
  SwitchField,
  Textarea,
} from './ui-kit/index.js'
import styles from './dsh-extension-settings.module.css'

type DshPluginCatalogEntry = HostApiResponse<'dshPlugins'>['plugins'][number]
type DshPluginEntry = NonNullable<DshPluginCatalogEntry['entries']>[number]
type DshPluginConfigInspection = HostApiResponse<'inspectDshPluginEntryConfig'>
type DshSettingsNamespaceView = HostApiResponse<'dshSettings'>['namespaces'][number]
type DshCredentialView = HostApiResponse<'dshCredentialsDescribe'>['credentials'][string]
type DshSettingsPathOperation = HostApiRequest<'dshSettingsMutate'>['ops'][number]

interface DshSettingsCatalog {
  readonly plugins: readonly DshPluginCatalogEntry[]
  readonly namespaces: readonly DshSettingsNamespaceView[]
}

interface DshSettingsCatalogEntry {
  readonly id: string
  readonly label: string
  readonly version: string
  readonly namespaces: readonly DshSettingsNamespaceView[]
  readonly plugin?: DshPluginCatalogEntry
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const requestHostApi = async <Output,>(
  contract: HostApiContract,
  responseSchema: { parse(input: unknown): Output },
  params: unknown,
  request: unknown,
): Promise<Output> => {
  const url = buildHostApiContractPath(contract, params)
  const requestBody = contract.parseRequest(request)
  const response = await fetch(url, {
    method: contract.method,
    headers: { 'content-type': 'application/json' },
    ...(contract.method === 'GET' || requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }),
  })
  const responseBody: unknown = await response.json()
  if (!response.ok) {
    const parsedError = HostApiErrorSchema.safeParse(responseBody)
    throw Object.assign(
      new Error(parsedError.success ? parsedError.data.error.message : `请求失败（HTTP ${response.status}）。`),
      { status: response.status },
    )
  }
  return responseSchema.parse(responseBody)
}

const loadCatalog = async (): Promise<DshSettingsCatalog> => {
  const [plugins, settings] = await Promise.all([
    requestHostApi(HostApiContracts.dshPlugins, HostApiContracts.dshPlugins.response, {}, undefined),
    requestHostApi(HostApiContracts.dshSettings, HostApiContracts.dshSettings.response, {}, undefined),
  ])
  return { plugins: plugins.plugins, namespaces: settings.namespaces }
}

const parseDshSettingsChangedEvent = (text: string) => {
  try {
    return DshSettingsChangedSseDataSchema.parse(parseJsonValue(JSON.parse(text)))
  } catch {
    return undefined
  }
}

const parseDshCredentialsChangedEvent = (text: string) => {
  try {
    return DshCredentialsChangedSseDataSchema.parse(parseJsonValue(JSON.parse(text)))
  } catch {
    return undefined
  }
}

const extensionSourceLabel = (origin: DshPluginCatalogEntry['origin']): string =>
  origin === 'builtin' ? '内置' : origin === 'profile' || origin === 'installed' ? '用户安装' : '动态加载'

const extensionBadge = (plugin: DshPluginCatalogEntry): ReactNode =>
  plugin.loadError ? (
    <StatusBadge tone="error">加载失败</StatusBadge>
  ) : (
    <StatusBadge>{extensionSourceLabel(plugin.origin)}</StatusBadge>
  )

const packageLabel = (name: string): string => {
  if (name === '@deepseek-ai/dsh-web-search-deepseek') return 'DeepSeek 网页搜索'
  if (name === '@deepseek-ai/dsh-agent-loop') return '思考与工具执行运行时'
  if (name === '@deepseek-ai/dsh-bash-sandbox') return '命令运行时'
  if (name === '@deepseek-ai/dsh-llm-pi-ai') return '模型供应商运行时'
  if (name === '@deepseek-ai/dsh-subagent') return '子智能体运行时'
  if (name === '@deepseek-ai/dsh-subagent-spawn-in-process') return '子智能体进程内启动'
  if (name === '@deepseek-ai/dsh-tool-subagent') return '子智能体委派工具'
  if (name === '@deepseek-ai/dsh-tool-subagent-control') return '子智能体控制工具'
  if (name.includes('subagent')) return '子智能体组件'
  if (name.includes('cordis-host-runner')) return '动态扩展运行组件'
  if (name.includes('compaction-tool-result-pruner')) return '工具结果裁剪'
  if (name.includes('llm-retry')) return '模型请求重试'
  if (name.includes('timeout-policy')) return '工具超时控制'
  if (name.includes('spill-policy')) return '大型结果持久化'
  if (name.includes('tool-web')) return '网页工具'
  if (name.endsWith('/dsh-web')) return '网页能力运行时'
  return name.replace('@deepseek-ai/', '')
}

const fieldDescription = (node: SchemaNode): string | undefined => {
  const description = node.meta?.description
  if (typeof description === 'string') return description
  if (description && typeof description['zh'] === 'string') return description['zh']
  if (description && typeof description['zh-CN'] === 'string') return description['zh-CN']
  return node.meta?.comment
}

const fieldHint = (node: SchemaNode): ReactNode => {
  const description = fieldDescription(node)
  const badges = node.meta?.badges ?? []
  const link = node.meta?.link
  if (!description && badges.length === 0 && !link) return undefined
  return (
    <span className={styles.fieldHintMeta}>
      {description ? <span>{description}</span> : null}
      {badges.map((badge) => (
        <span className={styles.schemaBadge} data-type={badge.type} key={`${badge.type}:${badge.text}`}>
          {badge.text}
        </span>
      ))}
      {link ? (
        <a href={link} target="_blank" rel="noreferrer">
          查看说明
        </a>
      ) : null}
    </span>
  )
}

const pathKey = (path: readonly string[]): string => path.join('\u0000')

const defaultValueForNode = (node: SchemaNode): unknown => {
  if (node.meta?.default !== undefined) return node.meta.default
  if (node.type === 'string') return ''
  if (node.type === 'number') return node.meta?.min ?? 0
  if (node.type === 'boolean') return false
  if (node.type === 'array' || node.type === 'tuple') return []
  if (node.type === 'object' || node.type === 'dict') return {}
  if (node.type === 'const') return node.value
  return null
}

const displayConstValue = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value) ?? ''
}

const schemaChoiceLabel = (node: SchemaNode, index: number): string => {
  const description = fieldDescription(node)
  if (description) return description
  if (node.type === 'const') return displayConstValue(node.value)
  return `${node.type} ${index + 1}`
}

const containsSecretNode = (root: SchemaNode): boolean => {
  const seen = new Set<SchemaNode>()
  const visit = (node: SchemaNode): boolean => {
    if (seen.has(node)) return false
    seen.add(node)
    if (node.meta?.role === 'secret') return true
    if (node.inner && visit(node.inner)) return true
    if (node.list?.some(visit)) return true
    return Object.values(node.dict ?? {}).some(visit)
  }
  return visit(root)
}

const mergeSettingsLayers = (base: unknown, user: unknown): unknown => {
  if (!isRecord(base) || !isRecord(user)) return user === undefined ? base : user
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(user)) result[key] = mergeSettingsLayers(result[key], value)
  return result
}

const applySettingsOps = (
  user: unknown,
  ops: ReadonlyMap<string, DshSettingsPathOperation>,
): Record<string, unknown> => {
  let result = isRecord(user) ? { ...user } : {}
  for (const operation of ops.values()) {
    result =
      operation.op === 'set' ? setPath(result, operation.path, operation.value) : deletePath(result, operation.path)
  }
  return result
}

interface GenericFieldProps {
  readonly name: string
  readonly node: SchemaNode
  readonly path: readonly string[]
  readonly value: unknown
  readonly disabled: boolean
  readonly onSet: (path: readonly string[], value: unknown) => void
  readonly onUnset: (path: readonly string[]) => void
}

function SchemaGroup({
  name,
  node,
  disabled,
  children,
}: {
  readonly name: string
  readonly node: SchemaNode
  readonly disabled: boolean
  readonly children: ReactNode
}) {
  const hint = fieldHint(node)
  if (node.meta?.collapse) {
    return (
      <details className={styles.fieldGroup} data-collapsible="">
        <summary>{name}</summary>
        {hint ? <p>{hint}</p> : null}
        <div className={styles.collapsibleBody} aria-disabled={disabled}>
          {children}
        </div>
      </details>
    )
  }
  return (
    <fieldset className={styles.fieldGroup} disabled={disabled}>
      <legend>{name}</legend>
      {hint ? <p>{hint}</p> : null}
      {children}
    </fieldset>
  )
}

function UnsupportedField({ name, node, path, value, disabled, onSet, onUnset }: GenericFieldProps) {
  const secret = containsSecretNode(node)
  const [text, setText] = useState(() => JSON.stringify(value ?? defaultValueForNode(node), null, 2))
  const [error, setError] = useState('')
  if (secret) {
    return (
      <InlineFeedback tone="warning">
        “{name}”包含只写 Secret，当前 Schema 无法安全拆分编辑；已禁止整体 JSON 替换，避免清除或回显已有 Secret。
      </InlineFeedback>
    )
  }
  return (
    <Field
      label={name}
      hint={
        <>
          Schema 类型“{node.type}”使用高级 JSON 配置。{fieldHint(node)}
        </>
      }
      error={error || undefined}
    >
      <div className={styles.jsonField}>
        <Textarea value={text} disabled={disabled} rows={6} onChange={(event) => setText(event.currentTarget.value)} />
        <div className={styles.inlineActions}>
          <Button
            size="small"
            disabled={disabled}
            onClick={() => {
              try {
                onSet(path, parseJsonValue(JSON.parse(text)))
                setError('')
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause))
              }
            }}
          >
            应用 JSON 草稿
          </Button>
          <Button size="small" variant="ghost" disabled={disabled} onClick={() => onUnset(path)}>
            恢复继承值
          </Button>
        </div>
      </div>
    </Field>
  )
}

function DictField({ name, node, path, value, disabled, onSet, onUnset }: GenericFieldProps) {
  const [dictionaryEntryDraft, setDictionaryEntryDraft] = useState('')
  const entries = isRecord(value) ? value : {}
  const inner = node.inner!
  const replaceKey = (currentKey: string, nextKey: string): void => {
    if (!nextKey || nextKey === currentKey || Object.prototype.hasOwnProperty.call(entries, nextKey)) return
    onSet(
      path,
      Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key === currentKey ? nextKey : key, entry])),
    )
  }
  return (
    <SchemaGroup name={name} node={node} disabled={disabled}>
      {Object.entries(entries).map(([key, entry]) => (
        <div className={styles.collectionRow} key={key}>
          <Field label="键名">
            <Input
              defaultValue={key}
              disabled={disabled}
              onBlur={(event) => replaceKey(key, event.currentTarget.value.trim())}
            />
          </Field>
          <GenericField
            name={key}
            node={inner}
            path={[...path, key]}
            value={entry}
            disabled={disabled}
            onSet={onSet}
            onUnset={onUnset}
          />
          <div className={styles.collectionActions}>
            <Button
              size="small"
              variant="danger"
              disabled={disabled}
              onClick={() =>
                onSet(path, Object.fromEntries(Object.entries(entries).filter(([entryKey]) => entryKey !== key)))
              }
            >
              删除此键
            </Button>
          </div>
        </div>
      ))}
      <div className={styles.dictAddRow}>
        <Field label="新键名">
          <Input
            value={dictionaryEntryDraft}
            disabled={disabled}
            onChange={(event) => setDictionaryEntryDraft(event.currentTarget.value)}
          />
        </Field>
        <Button
          size="small"
          disabled={
            disabled ||
            !dictionaryEntryDraft.trim() ||
            Object.prototype.hasOwnProperty.call(entries, dictionaryEntryDraft.trim())
          }
          onClick={() => {
            const key = dictionaryEntryDraft.trim()
            if (!key) return
            onSet(path, { ...entries, [key]: defaultValueForNode(inner) })
            setDictionaryEntryDraft('')
          }}
        >
          添加键值
        </Button>
      </div>
    </SchemaGroup>
  )
}

function GenericField(props: GenericFieldProps): ReactNode {
  const { name, node, path, value, disabled, onSet, onUnset } = props
  if (node.meta?.hidden) return null
  const locked = disabled || node.meta?.disabled === true
  const description = fieldDescription(node)

  if (node.type === 'object') {
    return (
      <SchemaGroup name={name} node={node} disabled={locked}>
        {Object.entries(node.dict ?? {}).map(([key, child]) => (
          <GenericField
            key={key}
            name={key}
            node={child}
            path={[...path, key]}
            value={isRecord(value) ? value[key] : undefined}
            disabled={locked}
            onSet={onSet}
            onUnset={onUnset}
          />
        ))}
      </SchemaGroup>
    )
  }

  if (node.type === 'string') {
    const role = node.meta?.role
    return (
      <Field label={name} hint={fieldHint(node)}>
        <div className={styles.inputWithReset}>
          {role === 'textarea' ? (
            <Textarea
              value={typeof value === 'string' ? value : ''}
              required={node.meta?.required}
              disabled={locked}
              rows={5}
              onChange={(event) => onSet(path, event.currentTarget.value)}
            />
          ) : (
            <Input
              type={role === 'secret' ? 'password' : 'text'}
              value={typeof value === 'string' ? value : ''}
              placeholder={role === 'secret' ? '输入新值；已保存值无法查看' : undefined}
              pattern={node.meta?.pattern?.source}
              required={node.meta?.required}
              disabled={locked}
              onChange={(event) => onSet(path, event.currentTarget.value)}
            />
          )}
          <Button size="small" variant="ghost" disabled={locked} onClick={() => onUnset(path)}>
            <RotateCcw size={13} aria-hidden="true" /> 恢复
          </Button>
        </div>
      </Field>
    )
  }

  if (node.type === 'number') {
    return (
      <Field label={name} hint={fieldHint(node)}>
        <div className={styles.inputWithReset}>
          <Input
            type="number"
            value={typeof value === 'number' ? value : ''}
            min={node.meta?.min}
            max={node.meta?.max}
            step={node.meta?.step}
            disabled={locked}
            onChange={(event) => {
              const next = event.currentTarget.valueAsNumber
              if (Number.isFinite(next)) onSet(path, next)
            }}
          />
          <Button size="small" variant="ghost" disabled={locked} onClick={() => onUnset(path)}>
            <RotateCcw size={13} aria-hidden="true" /> 恢复
          </Button>
        </div>
      </Field>
    )
  }

  if (node.type === 'boolean') {
    return (
      <SwitchField
        label={name}
        description={description ?? '开启或关闭此配置。'}
        checked={value === true}
        disabled={locked}
        onCheckedChange={(checked) => onSet(path, checked)}
      />
    )
  }

  if (node.type === 'const') {
    return (
      <Field label={name} hint={fieldHint(node)}>
        <Input value={displayConstValue(node.value)} readOnly />
      </Field>
    )
  }

  if (node.type === 'array' && node.inner) {
    if (containsSecretNode(node.inner)) {
      return (
        <InlineFeedback tone="warning">
          “{name}”的集合项包含只写 Secret，因此整体添加、删除和排序不可用，以免覆盖未回传的值。
        </InlineFeedback>
      )
    }
    const entries: readonly unknown[] = Array.isArray(value) ? value : []
    return (
      <SchemaGroup name={name} node={node} disabled={locked}>
        {entries.map((entry, index) => (
          <div className={styles.collectionRow} key={index}>
            <GenericField
              name={`第 ${index + 1} 项`}
              node={node.inner!}
              path={[...path, String(index)]}
              value={entry}
              disabled={locked}
              onSet={onSet}
              onUnset={onUnset}
            />
            <div className={styles.collectionActions}>
              <Button
                size="small"
                variant="ghost"
                disabled={locked || index === 0}
                onClick={() => {
                  const next = [...entries]
                  ;[next[index - 1], next[index]] = [next[index], next[index - 1]]
                  onSet(path, next)
                }}
              >
                <ChevronUp size={13} aria-hidden="true" /> 上移
              </Button>
              <Button
                size="small"
                variant="ghost"
                disabled={locked || index === entries.length - 1}
                onClick={() => {
                  const next = [...entries]
                  ;[next[index], next[index + 1]] = [next[index + 1], next[index]]
                  onSet(path, next)
                }}
              >
                <ChevronDown size={13} aria-hidden="true" /> 下移
              </Button>
              <Button
                size="small"
                variant="danger"
                disabled={locked}
                onClick={() => onSet(path, entries.toSpliced(index, 1))}
              >
                删除此项
              </Button>
            </div>
          </div>
        ))}
        <Button
          size="small"
          disabled={locked}
          onClick={() => onSet(path, [...entries, defaultValueForNode(node.inner!)])}
        >
          添加一项
        </Button>
      </SchemaGroup>
    )
  }

  if (node.type === 'dict' && node.inner) {
    if (containsSecretNode(node.inner)) {
      return (
        <InlineFeedback tone="warning">
          “{name}”的键值包含只写 Secret，因此整体改名、添加和删除不可用，以免覆盖未回传的值。
        </InlineFeedback>
      )
    }
    return <DictField {...props} disabled={locked} />
  }

  if (node.type === 'tuple' && node.list) {
    const entries: readonly unknown[] = Array.isArray(value) ? value : []
    return (
      <SchemaGroup name={name} node={node} disabled={locked}>
        {node.list.map((child, index) => (
          <GenericField
            key={index}
            name={`第 ${index + 1} 项`}
            node={child}
            path={[...path, String(index)]}
            value={entries[index]}
            disabled={locked}
            onSet={onSet}
            onUnset={onUnset}
          />
        ))}
      </SchemaGroup>
    )
  }

  if (node.type === 'union' && node.list && node.list.length > 0) {
    const matching = Math.max(
      0,
      node.list.findIndex((candidate) => {
        try {
          return validateDraft(candidate, value) === undefined
        } catch {
          return false
        }
      }),
    )
    return (
      <div className={styles.unionField}>
        <SelectField
          label={`${name}的配置类型`}
          value={String(matching)}
          disabled={locked}
          options={node.list.map((candidate, index) => ({
            value: String(index),
            label: schemaChoiceLabel(candidate, index),
          }))}
          onValueChange={(selected) => onSet(path, defaultValueForNode(node.list![Number(selected)]!))}
        />
        <GenericField {...props} node={node.list[matching]!} value={value} disabled={locked} />
      </div>
    )
  }

  if (node.type === 'intersect' && node.list?.every((candidate) => candidate.type === 'object')) {
    const dict: Record<string, SchemaNode> = {}
    for (const candidate of node.list) Object.assign(dict, candidate.dict ?? {})
    return (
      <SchemaGroup name={name} node={node} disabled={locked}>
        {Object.entries(dict).map(([key, child]) => (
          <GenericField
            key={key}
            name={key}
            node={child}
            path={[...path, key]}
            value={isRecord(value) ? value[key] : undefined}
            disabled={locked}
            onSet={onSet}
            onUnset={onUnset}
          />
        ))}
      </SchemaGroup>
    )
  }

  return <UnsupportedField {...props} disabled={locked} />
}

function DshPluginConfigEditor({
  entry,
  inspection,
  onChange,
}: {
  readonly entry: DshPluginEntry
  readonly inspection: DshPluginConfigInspection | undefined
  readonly onChange: (value: unknown) => void
}) {
  const schema = useMemo(() => {
    if (inspection?.mode !== 'schema') return undefined
    try {
      return rehydrateSchema(inspection.schema)
    } catch {
      return undefined
    }
  }, [inspection])
  const [draft, setDraft] = useState<unknown>(entry.config)
  useEffect(() => setDraft(entry.config), [entry.config])
  if (!inspection) return <InlineFeedback tone="info">正在检查插件 Config Schema…</InlineFeedback>
  if (inspection.mode === 'incompatible') return <InlineFeedback tone="error">{inspection.reason}</InlineFeedback>
  if (inspection.mode !== 'schema' || !schema) return null
  return (
    <div className={styles.fieldGroup}>
      <strong>启动配置</strong>
      <GenericField
        name={entry.entryKey}
        node={schema}
        path={[]}
        value={draft}
        disabled={false}
        onSet={(path, value) => {
          const next = path.length === 0 ? value : setPath(isRecord(draft) ? draft : {}, path, value)
          setDraft(next)
          onChange(next)
        }}
        onUnset={(path) => {
          const next = path.length === 0 ? {} : deletePath(isRecord(draft) ? draft : {}, path)
          setDraft(next)
          onChange(next)
        }}
      />
    </div>
  )
}

function CredentialEditor({ refName, onChanged }: { readonly refName: string; readonly onChanged: () => void }) {
  const [info, setInfo] = useState<DshCredentialView | null>(null)
  const [value, setValue] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [clearOpen, setClearOpen] = useState(false)
  const [clearError, setClearError] = useState('')
  const credentialInputRef = useRef<HTMLInputElement>(null)
  const clearedRef = useRef(false)
  const load = useCallback(async () => {
    const result = await requestHostApi(
      HostApiContracts.dshCredentialsDescribe,
      HostApiContracts.dshCredentialsDescribe.response,
      {},
      { refs: [refName] },
    )
    setInfo(result.credentials[refName] ?? { configured: false, writable: false })
  }, [refName])
  useEffect(() => {
    void load().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [load])
  const save = async (): Promise<void> => {
    if (!value || pending) return
    setPending(true)
    setError('')
    try {
      setInfo(
        await requestHostApi(
          HostApiContracts.dshCredentialSet,
          HostApiContracts.dshCredentialSet.response,
          { ref: refName },
          { value },
        ),
      )
      setValue('')
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }
  return (
    <div className={styles.credentialEditor}>
      <div className={styles.credentialHeading}>
        <KeyRound size={16} aria-hidden="true" />
        <span>
          <strong>凭据 {refName}</strong>
          <small>{info?.configured ? `已配置${info.source ? ` · 来源 ${info.source}` : ''}` : '尚未配置'}</small>
        </span>
        <StatusBadge tone={info?.configured ? 'success' : 'warning'}>
          {info?.configured ? '已保存' : '待配置'}
        </StatusBadge>
      </div>
      <Field label="新的凭据值" hint="凭据仅可覆盖，无法查看已保存值。" error={error || undefined}>
        <SecretInput ref={credentialInputRef} value={value} onChange={(event) => setValue(event.currentTarget.value)} />
      </Field>
      <div className={styles.inlineActions}>
        <Button
          variant="primary"
          loading={pending}
          loadingLabel="正在保存…"
          disabled={!value || info?.writable === false}
          onClick={() => void save()}
        >
          保存凭据
        </Button>
        <Button
          variant="danger"
          disabled={pending || !info?.configured || info.writable === false}
          onClick={() => {
            clearedRef.current = false
            setClearError('')
            setClearOpen(true)
          }}
        >
          清除凭据
        </Button>
      </div>
      <ConfirmDialog
        open={clearOpen}
        onOpenChange={(open) => {
          setClearOpen(open)
          if (!open) setClearError('')
        }}
        title={`清除“${refName}”`}
        description="清除后，依赖这个凭据的功能将不可用；已保存值无法从浏览器恢复。"
        cancelLabel="保留凭据"
        confirmLabel="清除该凭据"
        confirmVariant="danger"
        confirmLoadingLabel="正在清除…"
        onCloseAutoFocus={(event) => {
          if (!clearedRef.current || !credentialInputRef.current) return
          event.preventDefault()
          credentialInputRef.current.focus()
        }}
        onConfirm={async () => {
          setClearError('')
          try {
            const next = await requestHostApi(
              HostApiContracts.dshCredentialUnset,
              HostApiContracts.dshCredentialUnset.response,
              { ref: refName },
              undefined,
            )
            clearedRef.current = true
            setInfo(next)
            setValue('')
            onChanged()
            notify('凭据已清除。', 'success', `dsh-credential-clear:${refName}`)
            return true
          } catch (cause) {
            setClearError(cause instanceof Error ? cause.message : String(cause))
            return false
          }
        }}
      >
        {clearError ? <InlineFeedback tone="error">清除失败：{clearError}</InlineFeedback> : null}
      </ConfirmDialog>
    </div>
  )
}

function NamespaceEditor({
  namespace,
  onSaved,
}: {
  readonly namespace: DshSettingsNamespaceView
  readonly onSaved: () => void
}) {
  const [authority, setAuthority] = useState(namespace)
  const [ops, setOps] = useState<ReadonlyMap<string, DshSettingsPathOperation>>(() => new Map())
  useUnsavedDraft(`dsh-settings:${namespace.ns}`, ops.size > 0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [conflict, setConflict] = useState(false)
  const schema = useMemo(() => {
    try {
      return rehydrateSchema(namespace.schema)
    } catch {
      return undefined
    }
  }, [namespace.schema])
  useEffect(() => {
    if (namespace.ns !== authority.ns) {
      setAuthority(namespace)
      setOps(new Map())
      setError('')
      setNotice('')
      setConflict(false)
      return
    }
    if (namespace.revision !== authority.revision) {
      setAuthority(namespace)
      setConflict(ops.size > 0)
      if (ops.size === 0) setError('')
    }
  }, [namespace])
  const onSet = (path: readonly string[], value: unknown): void => {
    if (path.length === 0) {
      setError('DSH Settings 只允许路径级修改，当前根 Schema 无法安全整体替换。')
      return
    }
    const parsedValue = JsonValueSchema.safeParse(value)
    if (!parsedValue.success) {
      setError('DSH Settings 修改值必须是合法 JSON。')
      return
    }
    setNotice('')
    setOps((current) => new Map(current).set(pathKey(path), { op: 'set', path: [...path], value: parsedValue.data }))
  }
  const onUnset = (path: readonly string[]): void => {
    if (path.length === 0) {
      setError('DSH Settings 只允许路径级修改，当前根 Schema 无法安全整体替换。')
      return
    }
    setNotice('')
    setOps((current) => new Map(current).set(pathKey(path), { op: 'unset', path: [...path] }))
  }
  const save = async (): Promise<void> => {
    if (saving || ops.size === 0) return
    setSaving(true)
    setError('')
    setConflict(false)
    try {
      if (schema) {
        const validation = validateDraft(schema, rootValue)
        if (validation) throw new Error(validation)
      }
      const saved = await requestHostApi(
        HostApiContracts.dshSettingsMutate,
        HostApiContracts.dshSettingsMutate.response,
        { namespace: authority.ns },
        { expectedRevision: authority.revision, ops: [...ops.values()] },
      )
      setAuthority(saved)
      setOps(new Map())
      setNotice(saved.applies === 'restart' ? '已保存，重启后生效。' : '已保存并实时生效。')
      onSaved()
    } catch (cause) {
      const status =
        cause instanceof Error && 'status' in cause && typeof cause.status === 'number' ? cause.status : undefined
      if (status === 409) {
        setConflict(true)
        try {
          const latest = await requestHostApi(
            HostApiContracts.dshSettings,
            HostApiContracts.dshSettings.response,
            {},
            undefined,
          )
          const descriptor = latest.namespaces.find((item) => item.ns === authority.ns)
          if (descriptor) setAuthority(descriptor)
        } catch {
          // Keep the original conflict and draft; a later SSE/manual save can refresh authority.
        }
      }
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }
  const rootValue = useMemo(() => {
    if (!schema) return authority.resolved
    const user = applySettingsOps(authority.user, ops)
    try {
      return parseJsonValue(schema(mergeSettingsLayers(authority.base ?? {}, user)))
    } catch {
      return mergeSettingsLayers(authority.resolved, user)
    }
  }, [authority, ops, schema])
  const credentialRefs = useMemo(() => {
    if (!schema) return []
    const refs: string[] = []
    const walk = (node: SchemaNode, path: readonly string[]): void => {
      if (node.meta?.role === 'credential-ref') {
        const value = getPath(rootValue, path)
        if (typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) refs.push(value)
      }
      if (node.type === 'object')
        for (const [key, child] of Object.entries(node.dict ?? {})) walk(child, [...path, key])
      if (node.type === 'dict' && node.inner && isRecord(getPath(rootValue, path))) {
        const current = getPath(rootValue, path)
        if (isRecord(current)) for (const key of Object.keys(current)) walk(node.inner, [...path, key])
      }
      if (node.type === 'array' && node.inner && Array.isArray(getPath(rootValue, path))) {
        const current = getPath(rootValue, path)
        if (Array.isArray(current)) for (const index of current.keys()) walk(node.inner, [...path, String(index)])
      }
      if (node.type === 'tuple' && node.list) node.list.forEach((child, index) => walk(child, [...path, String(index)]))
    }
    walk(schema, [])
    return [...new Set(refs)]
  }, [rootValue, schema])

  return (
    <div className={styles.namespaceEditor}>
      <div className={styles.namespaceMeta}>
        <span>Namespace：{authority.ns}</span>
        <span>配置版本：{authority.revision}</span>
        <span>{authority.applies === 'live' ? '保存后实时生效' : '保存后需要重启'}</span>
      </div>
      {authority.ns === 'web-search-deepseek' ? (
        <InlineFeedback tone="warning">
          每次网页搜索都会产生额外模型请求费用；网页内容属于外部不可信输入。当前默认生成上限为 1024
          tokens、每次请求最多使用 2 次搜索；结果最多返回 5 条，工具超时 60 秒。前两项是 Provider
          设置，修改会影响下一次搜索的费用和时延。
        </InlineFeedback>
      ) : null}
      {schema ? (
        <GenericField
          name={namespace.ns}
          node={schema}
          path={[]}
          value={rootValue}
          disabled={!authority.writable}
          onSet={onSet}
          onUnset={onUnset}
        />
      ) : (
        <InlineFeedback tone="error">当前 Schema 无法安全恢复，已停止编辑，避免写入错误配置。</InlineFeedback>
      )}
      {credentialRefs.map((refName) => (
        <CredentialEditor refName={refName} onChanged={onSaved} key={refName} />
      ))}
      {conflict ? (
        <InlineFeedback tone="warning">配置已在其他位置更新；当前草稿已保留，请核对后重新保存。</InlineFeedback>
      ) : null}
      {notice ? <InlineFeedback tone="success">{notice}</InlineFeedback> : null}
      {error ? <InlineFeedback tone="error">{error}</InlineFeedback> : null}
      <div className={styles.editorFooter}>
        <span>{ops.size > 0 ? `${ops.size} 项未保存更改` : '没有未保存更改'}</span>
        <Button
          variant="primary"
          loading={saving}
          loadingLabel="正在保存…"
          disabled={ops.size === 0 || !schema || !authority.writable}
          onClick={() => void save()}
        >
          保存扩展配置
        </Button>
      </div>
    </div>
  )
}

export function DshExtensionSettings() {
  const agents = useProductStore((state) => state.agents)
  const [catalog, setCatalog] = useState<DshSettingsCatalog>({ plugins: [], namespaces: [] })
  const [selectedEntryId, setSelectedEntryId] = useState('')
  const [selectedNamespace, setSelectedNamespace] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [installSpec, setInstallSpec] = useState('')
  const [installInspection, setInstallInspection] = useState<HostApiResponse<'inspectDshPluginInstall'> | null>(null)
  const [approvedBuilds, setApprovedBuilds] = useState<Record<string, boolean>>({})
  const [installing, setInstalling] = useState(false)
  const [activeOperationId, setActiveOperationId] = useState('')
  const [operationProgress, setOperationProgress] = useState('')
  const [entryScope, setEntryScope] = useState<Record<string, 'host' | 'agent'>>({})
  const [entryAgent, setEntryAgent] = useState<Record<string, string>>({})
  const [entryConfig, setEntryConfig] = useState<Record<string, string>>({})
  const [configInspections, setConfigInspections] = useState<Record<string, DshPluginConfigInspection>>({})
  const [configInspecting, setConfigInspecting] = useState<Record<string, boolean>>({})
  const [operationError, setOperationError] = useState('')
  const [operationNotice, setOperationNotice] = useState('')
  const [removeOpen, setRemoveOpen] = useState(false)
  const refresh = useCallback(async () => {
    try {
      const next = await loadCatalog()
      setCatalog(next)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void refresh()
    const settingsListener = (event: unknown): void => {
      if (!(event instanceof MessageEvent) || typeof event.data !== 'string') return
      if (parseDshSettingsChangedEvent(event.data) === undefined) return
      void refresh()
    }
    const credentialsListener = (event: unknown): void => {
      if (!(event instanceof MessageEvent) || typeof event.data !== 'string') return
      if (parseDshCredentialsChangedEvent(event.data) === undefined) return
      void refresh()
    }
    const pluginsListener = (): void => {
      void refresh()
    }
    const operationListener = (event: unknown): void => {
      if (!(event instanceof MessageEvent) || typeof event.data !== 'string') return
      try {
        const progress = DshPluginOperationSseDataSchema.parse(JSON.parse(event.data))
        if (progress.operationId !== activeOperationId) return
        setOperationProgress(progress.message)
      } catch {
        // Ignore malformed or unrelated operation frames; the HTTP request remains authoritative.
      }
    }
    return productHostEventStream.subscribe({
      'dsh-settings-changed': settingsListener,
      'dsh-credentials-changed': credentialsListener,
      'dsh-plugins-changed': pluginsListener,
      'dsh-plugin-operation': operationListener,
    })
  }, [activeOperationId, refresh])
  const entries = useMemo<readonly DshSettingsCatalogEntry[]>(() => {
    const claimed = new Set(catalog.plugins.flatMap((plugin) => plugin.settingsNamespaces))
    return [
      ...catalog.plugins.map((plugin) => ({
        id: `plugin:${plugin.packageId ?? plugin.packageName}`,
        label: packageLabel(plugin.packageName),
        version: plugin.packageVersion,
        namespaces: catalog.namespaces.filter((namespace) => plugin.settingsNamespaces.includes(namespace.ns)),
        plugin,
      })),
      ...catalog.namespaces
        .filter((namespace) => !claimed.has(namespace.ns))
        .map((namespace) => ({
          id: `namespace:${namespace.ns}`,
          label: namespace.owner ? packageLabel(namespace.owner.packageName) : namespace.ns,
          version: namespace.owner?.packageVersion ?? '运行时注册',
          namespaces: [namespace],
        })),
    ]
  }, [catalog])
  useEffect(() => {
    if (entries.length === 0) {
      setSelectedEntryId('')
      return
    }
    if (!entries.some((entry) => entry.id === selectedEntryId)) {
      setSelectedEntryId(
        entries.find((entry) => entry.plugin?.packageName === '@deepseek-ai/dsh-web-search-deepseek')?.id ??
          entries.find((entry) => entry.namespaces.length > 0)?.id ??
          entries[0]!.id,
      )
    }
  }, [entries, selectedEntryId])
  const selectedEntry = entries.find((entry) => entry.id === selectedEntryId)
  const selected = selectedEntry?.plugin
  const namespaces = selectedEntry?.namespaces ?? []
  const defaultAgentSelection = agents[0]?.id ?? ''
  const activeNamespace = namespaces.find((item) => item.ns === selectedNamespace) ?? namespaces[0]
  useEffect(() => {
    setSelectedNamespace(namespaces[0]?.ns ?? '')
  }, [selectedEntryId])

  const inspectRegistryPackage = async (): Promise<void> => {
    if (!installSpec.trim() || installing) return
    setInstalling(true)
    const operationId = crypto.randomUUID()
    setActiveOperationId(operationId)
    setOperationProgress('正在开始安装检查…')
    setOperationError('')
    setOperationNotice('')
    try {
      const inspection = await requestHostApi(
        HostApiContracts.inspectDshPluginInstall,
        HostApiContracts.inspectDshPluginInstall.response,
        {},
        { spec: installSpec.trim(), operationId },
      )
      setInstallInspection(inspection)
      setApprovedBuilds(Object.fromEntries(inspection.blockedBuilds.map((name) => [name, false])))
    } catch (cause) {
      setInstallInspection(null)
      setOperationError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setInstalling(false)
    }
  }

  const inspectTarball = async (file: File): Promise<void> => {
    setInstalling(true)
    const operationId = crypto.randomUUID()
    setActiveOperationId(operationId)
    setOperationProgress('正在上传安装包…')
    setOperationError('')
    setOperationNotice('')
    try {
      const response = await fetch('/api/dsh/plugin-installs/inspect-tarball', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-file-name': file.name,
          'x-operation-id': operationId,
        },
        body: file,
      })
      const body: unknown = await response.json()
      if (!response.ok) {
        const parsedError = HostApiErrorSchema.safeParse(body)
        throw new Error(parsedError.success ? parsedError.data.error.message : `请求失败（HTTP ${response.status}）。`)
      }
      setInstallInspection(HostApiContracts.inspectDshPluginInstall.parseResponse(body))
      const parsed = HostApiContracts.inspectDshPluginInstall.parseResponse(body)
      setInstallInspection(parsed)
      setApprovedBuilds(Object.fromEntries(parsed.blockedBuilds.map((name) => [name, false])))
    } catch (cause) {
      setInstallInspection(null)
      setOperationError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setInstalling(false)
    }
  }

  const commitInstall = async (): Promise<void> => {
    if (!installInspection || installing) return
    setInstalling(true)
    const operationId = crypto.randomUUID()
    setActiveOperationId(operationId)
    setOperationProgress('正在提交安装…')
    setOperationError('')
    setOperationNotice('')
    try {
      await requestHostApi(
        HostApiContracts.commitDshPluginInstall,
        HostApiContracts.commitDshPluginInstall.response,
        {},
        {
          token: installInspection.token,
          approvedBuilds: installInspection.blockedBuilds.filter((name) => approvedBuilds[name] === true),
          operationId,
        },
      )
      setInstallInspection(null)
      setInstallSpec('')
      setOperationNotice('DSH 插件已安装并保持关闭。')
      await refresh()
    } catch (cause) {
      setOperationError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setInstalling(false)
    }
  }

  const activateEntry = async (entry: NonNullable<DshPluginCatalogEntry['entries']>[number]): Promise<void> => {
    const configInspection = configInspections[entry.id]
    if (!configInspection) {
      setOperationError('需要检查入口的 Config Schema；检查操作会初始化第三方模块。')
      return
    }
    if (configInspection.mode === 'incompatible') {
      setOperationError(configInspection.reason)
      return
    }
    const target = entryScope[entry.id] ?? entry.selectedScope ?? entry.suggestedScope
    const agentId = entryAgent[entry.id] ?? agents[0]?.id
    if (target === 'agent' && !agentId) {
      setOperationError('当前没有可选择的智能体。创建智能体后可启用该入口。')
      return
    }
    setOperationError('')
    setOperationNotice('')
    try {
      const config = parseJsonValue(JSON.parse(entryConfig[entry.id] ?? JSON.stringify(entry.config)))
      await requestHostApi(
        HostApiContracts.activateDshPluginEntry,
        HostApiContracts.activateDshPluginEntry.response,
        { entryId: entry.id },
        { target, ...(target === 'agent' ? { agentId } : {}), config },
      )
      setOperationNotice(target === 'host' ? '入口已在本机启用。' : '入口已给所选智能体启用。')
      await refresh()
    } catch (cause) {
      setOperationError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const inspectEntryConfig = async (entryId: string): Promise<void> => {
    setConfigInspecting((current) => ({ ...current, [entryId]: true }))
    setOperationError('')
    try {
      const inspection = await requestHostApi(
        HostApiContracts.inspectDshPluginEntryConfig,
        HostApiContracts.inspectDshPluginEntryConfig.response,
        { entryId },
        undefined,
      )
      setConfigInspections((current) => ({ ...current, [entryId]: inspection }))
    } catch (cause) {
      setOperationError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setConfigInspecting((current) => ({ ...current, [entryId]: false }))
    }
  }

  const deactivateEntry = async (entryId: string, targetKey: string): Promise<void> => {
    setOperationError('')
    setOperationNotice('')
    try {
      await requestHostApi(
        HostApiContracts.deactivateDshPluginEntry,
        HostApiContracts.deactivateDshPluginEntry.response,
        { entryId },
        { targetKey },
      )
      setOperationNotice('入口已关闭并完成资源清理。')
      await refresh()
    } catch (cause) {
      setOperationError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  if (loading) return <InlineFeedback tone="info">正在读取 DSH 扩展和配置…</InlineFeedback>
  if (error && catalog.plugins.length === 0) return <InlineFeedback tone="error">{error}</InlineFeedback>
  return (
    <div className={styles.catalog}>
      <aside className={styles.pluginList} aria-label="DSH 扩展">
        <div className={styles.listHeading}>安装 DSH 插件</div>
        <Field label="npm 包与精确版本" hint="例如 @scope/plugin@1.2.3；版本范围会在预检时解析为精确版本。">
          <Input
            value={installSpec}
            placeholder="package-name@1.2.3"
            disabled={installing}
            onChange={(event) => setInstallSpec(event.currentTarget.value)}
          />
        </Field>
        <Button loading={installing} disabled={!installSpec.trim()} onClick={() => void inspectRegistryPackage()}>
          检查安装内容
        </Button>
        <Field label="npm tgz 或 .nxt-extension" hint="从本机选择一个安装包进行预检。">
          <label className={styles.installFileButton} data-disabled={installing ? '' : undefined}>
            <Upload size={14} aria-hidden="true" />
            {installing ? '正在检查…' : '选择安装包'}
            <Input
              className={styles.installFileInput}
              type="file"
              accept=".tgz,.tar.gz,.nxt-extension,application/gzip,application/vnd.nekro-nxt.extension+zip"
              aria-label="选择 npm tgz 或 .nxt-extension"
              disabled={installing}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                if (file) void inspectTarball(file)
                event.currentTarget.value = ''
              }}
            />
          </label>
        </Field>
        {installInspection ? (
          <div className={styles.fieldGroup}>
            <strong>{installInspection.packageName}</strong>
            <small>精确版本 {installInspection.packageVersion}</small>
            <small>{installInspection.entries.length} 个入口 · 安装完成时未启用</small>
            {installInspection.blockedBuilds.length > 0 ? (
              <>
                <InlineFeedback tone="warning">
                  以下依赖声明了构建脚本。未批准的依赖按禁用脚本方式安装；批准记录绑定当前精确版本和依赖锁摘要。
                </InlineFeedback>
                {installInspection.blockedBuilds.map((name) => (
                  <SwitchField
                    key={name}
                    label={name}
                    description="允许这个依赖执行安装构建脚本"
                    checked={approvedBuilds[name] === true}
                    onCheckedChange={(checked) => setApprovedBuilds((current) => ({ ...current, [name]: checked }))}
                  />
                ))}
              </>
            ) : (
              <InlineFeedback tone="success">依赖未请求执行被阻止的构建脚本。</InlineFeedback>
            )}
            <Button variant="primary" loading={installing} onClick={() => void commitInstall()}>
              安装插件（未启用）
            </Button>
          </div>
        ) : null}
        {installing && operationProgress ? <InlineFeedback tone="info">{operationProgress}</InlineFeedback> : null}
        <div className={styles.listHeading}>DSH 扩展目录</div>
        {entries.map((entry) => (
          <Button
            variant="ghost"
            className={[styles.pluginButton, entry.id === selectedEntryId ? styles.pluginButtonActive : '']
              .filter(Boolean)
              .join(' ')}
            onClick={() => setSelectedEntryId(entry.id)}
            key={entry.id}
          >
            <span>
              <strong>{entry.label}</strong>
              <small>{entry.version}</small>
            </span>
            {entry.plugin ? extensionBadge(entry.plugin) : <StatusBadge>其他扩展</StatusBadge>}
          </Button>
        ))}
      </aside>
      <section className={styles.detail}>
        {selectedEntry ? (
          <>
            <div className={styles.detailHeader}>
              <div>
                <h2>{selectedEntry.label}</h2>
                <p>{selected?.packageName ?? `DSH Settings namespace · ${activeNamespace?.ns ?? ''}`}</p>
              </div>
              {selected ? extensionBadge(selected) : <StatusBadge>其他扩展</StatusBadge>}
            </div>
            {!selected ? (
              <InlineFeedback tone="info">此配置由当前 DSH Host 运行时注册，可以使用基础 Schema 配置。</InlineFeedback>
            ) : null}
            {selected?.loadError ? <InlineFeedback tone="error">{selected.loadError.message}</InlineFeedback> : null}
            {selected?.clientUiDetected ? (
              <InlineFeedback tone="info">
                插件包含 DSH 原生界面，NekroNXT 当前未接入。Host 能力和通用配置正常可用。
              </InlineFeedback>
            ) : null}
            {selected?.origin === 'installed' ? (
              <>
                {(selected.entries ?? []).map((entry) => {
                  const scope = entryScope[entry.id] ?? entry.selectedScope ?? entry.suggestedScope
                  const configText = entryConfig[entry.id] ?? JSON.stringify(entry.config, null, 2)
                  const configInspection = configInspections[entry.id]
                  return (
                    <fieldset className={styles.fieldGroup} key={entry.id}>
                      <legend>{entry.entryKey}</legend>
                      <p>{entry.moduleName}</p>
                      <SelectField
                        label="启用范围"
                        value={scope}
                        disabled={entry.activations.length > 0}
                        options={[
                          { value: 'host', label: entry.suggestedScope === 'host' ? '本机（建议）' : '本机' },
                          {
                            value: 'agent',
                            label: entry.suggestedScope === 'agent' ? '指定智能体（建议）' : '指定智能体',
                          },
                        ]}
                        onValueChange={(value) => {
                          if (value !== 'host' && value !== 'agent') return
                          setEntryScope((current) => ({ ...current, [entry.id]: value }))
                        }}
                      />
                      {scope === 'agent' ? (
                        <SelectField
                          label="智能体"
                          value={entryAgent[entry.id] ?? defaultAgentSelection}
                          options={agents.map((agent) => ({ value: agent.id, label: agent.name }))}
                          onValueChange={(agentId) => setEntryAgent((current) => ({ ...current, [entry.id]: agentId }))}
                        />
                      ) : null}
                      {!configInspection ? (
                        <>
                          <InlineFeedback tone="warning">
                            检查 Config Schema 和启用入口会初始化第三方模块。执行这些操作表示你信任当前安装来源。
                          </InlineFeedback>
                          <Button
                            loading={configInspecting[entry.id] === true}
                            onClick={() => void inspectEntryConfig(entry.id)}
                          >
                            检查配置界面
                          </Button>
                        </>
                      ) : null}
                      {configInspection?.mode === 'schema' ? (
                        <DshPluginConfigEditor
                          entry={entry}
                          inspection={configInspection}
                          onChange={(value) =>
                            setEntryConfig((current) => ({ ...current, [entry.id]: JSON.stringify(value, null, 2) }))
                          }
                        />
                      ) : null}
                      {configInspection?.mode === 'json' ? (
                        <Field
                          label="启动配置（高级 JSON）"
                          hint="插件没有可序列化 Config Schema；不能在这里保存 Secret 或凭据。"
                        >
                          <Textarea
                            rows={6}
                            value={configText}
                            onChange={(event) =>
                              setEntryConfig((current) => ({ ...current, [entry.id]: event.currentTarget.value }))
                            }
                          />
                        </Field>
                      ) : null}
                      {configInspection?.mode === 'incompatible' ? (
                        <InlineFeedback tone="error">{configInspection.reason}</InlineFeedback>
                      ) : null}
                      <Button
                        variant="primary"
                        disabled={!configInspection || configInspection.mode === 'incompatible'}
                        onClick={() => void activateEntry(entry)}
                      >
                        {entry.activations.length > 0 ? '应用配置 / 添加授权' : '启用入口'}
                      </Button>
                      {entry.activations.map((activation) => (
                        <div className={styles.inlineActions} key={activation.targetKey}>
                          <StatusBadge tone={activation.diagnostic?.status === 'active' ? 'success' : 'warning'}>
                            {activation.target === 'host'
                              ? '本机已启用'
                              : `${agents.find((agent) => agent.id === activation.agentId)?.name ?? '智能体'}已启用`}
                          </StatusBadge>
                          {activation.diagnostic?.message ? <span>{activation.diagnostic.message}</span> : null}
                          <Button
                            size="small"
                            variant="danger"
                            onClick={() => void deactivateEntry(entry.id, activation.targetKey)}
                          >
                            关闭
                          </Button>
                        </div>
                      ))}
                    </fieldset>
                  )
                })}
                <Button variant="danger" onClick={() => setRemoveOpen(true)}>
                  <Trash2 size={14} aria-hidden="true" /> 移除这个插件
                </Button>
                {selected.packageId ? (
                  <Button
                    onClick={() =>
                      window.location.assign(
                        `/api/dsh/plugin-installs/${encodeURIComponent(selected.packageId!)}/export`,
                      )
                    }
                  >
                    导出分享包
                  </Button>
                ) : null}
                <ConfirmDialog
                  open={removeOpen}
                  onOpenChange={setRemoveOpen}
                  title={`移除“${selected.packageName}”`}
                  description={`移除操作会关闭 ${selected.entries?.flatMap((entry) => entry.activations).length ?? 0} 个启用关系。全部入口静止成功后，安装包移入回收目录。`}
                  cancelLabel="保留插件"
                  confirmLabel="关闭并移除"
                  confirmVariant="danger"
                  onConfirm={async () => {
                    if (!selected.packageId) return false
                    try {
                      await requestHostApi(
                        HostApiContracts.removeDshPluginPackage,
                        HostApiContracts.removeDshPluginPackage.response,
                        { packageId: selected.packageId },
                        undefined,
                      )
                      setOperationNotice('DSH 插件已关闭并移除。')
                      await refresh()
                      return true
                    } catch (cause) {
                      setOperationError(cause instanceof Error ? cause.message : String(cause))
                      return false
                    }
                  }}
                />
              </>
            ) : null}
            {operationNotice ? <InlineFeedback tone="success">{operationNotice}</InlineFeedback> : null}
            {operationError ? <InlineFeedback tone="error">{operationError}</InlineFeedback> : null}
            {namespaces.length > 1 ? (
              <SelectField
                label="配置区域"
                value={activeNamespace?.ns ?? ''}
                options={namespaces.map((item) => ({ value: item.ns, label: item.ns }))}
                onValueChange={setSelectedNamespace}
              />
            ) : null}
            {activeNamespace ? (
              <NamespaceEditor namespace={activeNamespace} onSaved={() => void refresh()} />
            ) : (
              <InlineFeedback tone="info">这个运行组件没有注册可在线编辑的 DSH Settings namespace。</InlineFeedback>
            )}
          </>
        ) : (
          <InlineFeedback tone="info">当前没有已识别的 DSH 扩展。</InlineFeedback>
        )}
      </section>
    </div>
  )
}
