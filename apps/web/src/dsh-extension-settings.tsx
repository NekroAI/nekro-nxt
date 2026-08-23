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
  DshSettingsChangedSseDataSchema,
  HostApiContracts,
  HostApiErrorSchema,
  buildHostApiContractPath,
  JsonValueSchema,
  parseJsonValue,
} from '@nekro-nxt/contracts'
import { ChevronDown, ChevronUp, KeyRound, RotateCcw, ShieldAlert } from 'lucide-react'
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { notify } from './components/notifications.js'
import { InlineFeedback } from './components/product-feedback.js'
import { DshNativeSettingsSlots } from './dynamic-client-coordinator.js'
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
  Tabs,
  Textarea,
} from './ui-kit/index.js'
import styles from './dsh-extension-settings.module.css'

type PluginSupportAssessment = HostApiResponse<'dshPlugins'>['plugins'][number]
type DshSettingsNamespaceView = HostApiResponse<'dshSettings'>['namespaces'][number]
type DshCredentialView = HostApiResponse<'dshCredentialsDescribe'>['credentials'][string]
type DshSettingsPathOperation = HostApiRequest<'dshSettingsMutate'>['ops'][number]

interface DshSettingsCatalog {
  readonly plugins: readonly PluginSupportAssessment[]
  readonly namespaces: readonly DshSettingsNamespaceView[]
}

interface DshSettingsCatalogEntry {
  readonly id: string
  readonly label: string
  readonly version: string
  readonly namespaces: readonly DshSettingsNamespaceView[]
  readonly plugin?: PluginSupportAssessment
}

class NativeSettingsBoundary extends Component<
  { readonly children: ReactNode; readonly onFailure: (message: string) => void },
  { readonly failed: boolean }
> {
  override state = { failed: false }

  static getDerivedStateFromError(): { readonly failed: true } {
    return { failed: true }
  }

  override componentDidCatch(error: Error): void {
    this.props.onFailure(error.message)
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
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
    ...(contract.method === 'GET' || contract.method === 'DELETE' ? {} : { body: JSON.stringify(requestBody) }),
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

const supportLabel = (status: PluginSupportAssessment['overall']): string => {
  if (status === 'verified') return '已验证支持'
  if (status === 'loadable-unverified') return '可加载，未完整验证'
  if (status === 'partial') return '部分支持'
  if (status === 'incompatible') return '不兼容'
  return '未评估'
}

const supportTone = (status: PluginSupportAssessment['overall']) => {
  if (status === 'verified') return 'success' as const
  if (status === 'loadable-unverified') return 'info' as const
  if (status === 'partial') return 'warning' as const
  if (status === 'incompatible') return 'error' as const
  return 'unknown' as const
}

const packageLabel = (name: string): string => {
  if (name === '@deepseek-ai/dsh-web-search-deepseek') return 'DeepSeek 网页搜索'
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
          “{name}”的集合项包含只写 Secret；当前版本禁止整体添加、删除和排序，避免覆盖未回传的值。
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
          “{name}”的键值包含只写 Secret；当前版本禁止整体改名、添加和删除，避免覆盖未回传的值。
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
  const [catalog, setCatalog] = useState<DshSettingsCatalog>({ plugins: [], namespaces: [] })
  const [selectedEntryId, setSelectedEntryId] = useState('')
  const [selectedNamespace, setSelectedNamespace] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [nativeFailure, setNativeFailure] = useState('')
  const [configView, setConfigView] = useState<'native' | 'generic'>('native')
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
    const source = new EventSource('/api/events')
    const settingsListener = (event: Event): void => {
      if (!(event instanceof MessageEvent) || typeof event.data !== 'string') return
      if (parseDshSettingsChangedEvent(event.data) === undefined) return
      void refresh()
    }
    const credentialsListener = (event: Event): void => {
      if (!(event instanceof MessageEvent) || typeof event.data !== 'string') return
      if (parseDshCredentialsChangedEvent(event.data) === undefined) return
      void refresh()
    }
    source.addEventListener('dsh-settings-changed', settingsListener)
    source.addEventListener('dsh-credentials-changed', credentialsListener)
    return () => source.close()
  }, [refresh])
  const entries = useMemo<readonly DshSettingsCatalogEntry[]>(() => {
    const claimed = new Set(catalog.plugins.flatMap((plugin) => plugin.settingsNamespaces))
    return [
      ...catalog.plugins.map((plugin) => ({
        id: `plugin:${plugin.packageName}`,
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
  const selectedOverall =
    nativeFailure && selected?.packageName === '@deepseek-ai/dsh-web-search-deepseek'
      ? ('partial' as const)
      : selected?.overall
  const namespaces = selectedEntry?.namespaces ?? []
  const activeNamespace = namespaces.find((item) => item.ns === selectedNamespace) ?? namespaces[0]
  useEffect(() => {
    setSelectedNamespace(namespaces[0]?.ns ?? '')
    setNativeFailure('')
    setConfigView('native')
  }, [selectedEntryId])
  const reportNativeFailure = useCallback((message: string) => {
    setNativeFailure(message)
    setConfigView('generic')
  }, [])

  if (loading) return <InlineFeedback tone="info">正在读取 DSH 扩展和配置…</InlineFeedback>
  if (error && catalog.plugins.length === 0) return <InlineFeedback tone="error">{error}</InlineFeedback>
  return (
    <div className={styles.catalog}>
      <aside className={styles.pluginList} aria-label="DSH 扩展">
        <div className={styles.listHeading}>已加载的 DSH 扩展</div>
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
            {entry.plugin ? (
              <StatusBadge
                tone={supportTone(
                  entry.id === selectedEntryId && selectedOverall ? selectedOverall : entry.plugin.overall,
                )}
              >
                {supportLabel(entry.id === selectedEntryId && selectedOverall ? selectedOverall : entry.plugin.overall)}
              </StatusBadge>
            ) : (
              <StatusBadge tone="unknown">未评估归属</StatusBadge>
            )}
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
              {selected ? (
                <StatusBadge tone={supportTone(selectedOverall ?? selected.overall)}>
                  {supportLabel(selectedOverall ?? selected.overall)}
                </StatusBadge>
              ) : (
                <StatusBadge tone="unknown">未评估归属</StatusBadge>
              )}
            </div>
            {selected ? (
              <div className={styles.facetList}>
                {selected.facets.map((facet) => (
                  <span
                    key={facet.facet}
                    data-status={nativeFailure && facet.facet === 'client-ui' ? 'failed' : facet.status}
                  >
                    {facet.facet} · {nativeFailure && facet.facet === 'client-ui' ? 'failed' : facet.status}
                  </span>
                ))}
              </div>
            ) : (
              <InlineFeedback tone="info">
                此 namespace 已由当前 DSH Host 注册，但尚未识别所属插件；可以使用基础 Schema 配置。
              </InlineFeedback>
            )}
            {selected && (selectedOverall === 'partial' || selectedOverall === 'incompatible') ? (
              <InlineFeedback tone={selectedOverall === 'incompatible' ? 'error' : 'warning'}>
                <ShieldAlert size={15} aria-hidden="true" />
                {selected.facets.flatMap((facet) => facet.evidence).find((evidence) => evidence.code)?.message ??
                  '存在尚未支持的能力面。'}
              </InlineFeedback>
            ) : null}
            {namespaces.length > 1 ? (
              <SelectField
                label="配置区域"
                value={activeNamespace?.ns ?? ''}
                options={namespaces.map((item) => ({ value: item.ns, label: item.ns }))}
                onValueChange={setSelectedNamespace}
              />
            ) : null}
            {selected?.packageName === '@deepseek-ai/dsh-web-search-deepseek' && activeNamespace ? (
              <Tabs.Root
                value={configView}
                onValueChange={(value) => {
                  if (value === 'native' || value === 'generic') setConfigView(value)
                }}
              >
                <Tabs.List aria-label="DSH 扩展配置界面">
                  <Tabs.Trigger value="native">DSH 原生界面</Tabs.Trigger>
                  <Tabs.Trigger value="generic">通用配置</Tabs.Trigger>
                </Tabs.List>
                {nativeFailure ? (
                  <InlineFeedback tone="warning">
                    原生界面未能加载：{nativeFailure}。已自动切换到通用配置。
                  </InlineFeedback>
                ) : null}
                <Tabs.Content value="native">
                  <div className={styles.nativeNotice}>
                    <StatusBadge tone="info">DSH 原生界面</StatusBadge>
                    <span>内部采用上游术语和交互；配置写入同一 DSH Settings/Credentials。</span>
                  </div>
                  {nativeFailure ? null : (
                    <NativeSettingsBoundary onFailure={reportNativeFailure}>
                      <div className={styles.nxtDshNativeSurface} data-dsh-native-surface="">
                        <DshNativeSettingsSlots onFailure={reportNativeFailure} />
                      </div>
                    </NativeSettingsBoundary>
                  )}
                </Tabs.Content>
                <Tabs.Content value="generic">
                  <NamespaceEditor namespace={activeNamespace} onSaved={() => void refresh()} />
                </Tabs.Content>
              </Tabs.Root>
            ) : activeNamespace ? (
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
