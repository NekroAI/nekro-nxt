import { ArrowRight, Cable, Check, Circle, Plus, Radio, Send } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { notify } from '../components/notifications.js'
import { EmptyState, InlineFeedback, PageHeader } from '../components/product-feedback.js'
import { useProductStore, type ConnectionState } from '../product-store.js'
import {
  Button,
  ConfirmDialog,
  Field,
  Input,
  SelectField,
  StatusBadge,
  SwitchField,
  type StatusTone,
} from '../ui-kit/index.js'
import styles from './product-pages.module.css'

const connectionTone = (state: ConnectionState): StatusTone => {
  if (state === '已连接') return 'success'
  if (state === '正在连接') return 'info'
  if (state === '认证过期') return 'warning'
  if (state === '异常') return 'error'
  return 'neutral'
}

const connectionLabel = (adapterKey: string, value: string): string =>
  adapterKey === 'web' || value === '本地 Web' ? '网页聊天' : value

const testResultLabel = (value: string): string => {
  if (value === '通过') return '通过'
  if (value === '未测试') return '未测试'
  return '未通过'
}

const maskedAccount = (value: string): string => {
  const trimmed = value.trim()
  if (!trimmed) return '未提供'
  return trimmed.length <= 4 ? '已提供' : `尾号 ${trimmed.slice(-4)}`
}

export const friendlyKnownChannelLabel = (channel: { readonly name: string; readonly kind: string }): string => {
  if (!/^(?:group|guild|private|c2c):/u.test(channel.name)) return channel.name
  const suffix = channel.name.match(/([\p{L}\p{N}]{4})$/u)?.[1]
  if (channel.kind === 'group') return suffix ? `QQ 群聊（尾号 ${suffix}）` : 'QQ 群聊'
  return suffix ? `QQ 私聊（尾号 ${suffix}）` : 'QQ 私聊'
}

export function ConnectionsPage() {
  const host = useProductStore((state) => state.host)
  const connections = useProductStore((state) => state.connections)
  const descriptors = useProductStore((state) => state.connectionAdapters)
  const agents = useProductStore((state) => state.agents)
  const channels = useProductStore((state) => state.channels)
  const navigate = useNavigate()
  const creatablePlatforms = useMemo(() => descriptors.filter((descriptor) => descriptor.userCreatable), [descriptors])
  const [selectedId, setSelectedId] = useState(connections[0]?.id ?? '')
  const [createOpen, setCreateOpen] = useState(false)
  const [createStage, setCreateStage] = useState<'platform' | 'configuration'>('platform')
  const [selectedPlatformKey, setSelectedPlatformKey] = useState('')
  const [configuration, setConfiguration] = useState<Record<string, string | number | boolean>>({})
  const [credentials, setCredentials] = useState<Record<string, string>>({})
  const [createError, setCreateError] = useState('')
  const [testPending, setTestPending] = useState<'receive' | 'send' | null>(null)
  const [testChannelByConnection, setTestChannelByConnection] = useState<Record<string, string>>({})
  const [bindingAgentId, setBindingAgentId] = useState(agents[0]?.id ?? '')

  useEffect(() => {
    if (!connections.some((connection) => connection.id === selectedId)) {
      setSelectedId(connections[0]?.id ?? '')
    }
  }, [connections, selectedId])

  useEffect(() => {
    if (!agents.some((agent) => agent.id === bindingAgentId)) setBindingAgentId(agents[0]?.id ?? '')
  }, [agents, bindingAgentId])

  const selected = connections.find((connection) => connection.id === selectedId) ?? connections[0]
  const selectedPlatform = creatablePlatforms.find((platform) => platform.key === selectedPlatformKey)
  const selectedTestChannelId = selected
    ? (testChannelByConnection[selected.id] ?? selected.knownChannels[0]?.id ?? '')
    : ''
  const sendTargetAvailable = selectedTestChannelId.length > 0
  const selectedChannels = selected ? channels.filter((channel) => channel.connectionId === selected.id) : []
  const bindingCount = selectedChannels.reduce((count, channel) => count + channel.bindings.length, 0)

  const openCreate = (): void => {
    setCreateStage('platform')
    setSelectedPlatformKey(creatablePlatforms[0]?.key ?? '')
    setConfiguration({})
    setCredentials({})
    setCreateError('')
    setCreateOpen(true)
  }

  const runTest = async (direction: 'receive' | 'send'): Promise<void> => {
    if (!selected || testPending) return
    setTestPending(direction)
    try {
      await useProductStore
        .getState()
        .runConnectionTest(
          selected.id,
          direction,
          direction === 'send' ? selectedTestChannelId || undefined : undefined,
        )
      notify(
        direction === 'receive' ? '接收测试已完成，结果已刷新。' : '测试消息已提交，结果已刷新。',
        'success',
        `connection-test:${selected.id}:${direction}`,
      )
    } catch (error) {
      notify(
        error instanceof Error ? error.message : String(error),
        'error',
        `connection-test:${selected.id}:${direction}`,
      )
    } finally {
      setTestPending(null)
    }
  }

  return (
    <div className={styles.page}>
      <PageHeader
        title="连接"
        meta={connections.length > 0 ? `${connections.length} 个平台账号` : undefined}
        actions={
          creatablePlatforms.length > 0 ? (
            <Button variant="primary" onClick={openCreate}>
              <Plus size={15} aria-hidden="true" /> 添加连接
            </Button>
          ) : undefined
        }
      />
      {connections.length === 0 ? (
        <EmptyState
          loading={host.status === 'initializing'}
          title={host.status === 'initializing' ? '正在读取连接' : '还没有可用连接'}
          description={
            host.status === 'error'
              ? '当前无法读取平台账号，请重新连接后再试。'
              : creatablePlatforms.length > 0
                ? '添加平台账号后，可接收频道消息并进行收发测试。'
                : '当前没有已安装且可由用户添加的平台。'
          }
          action={
            creatablePlatforms.length > 0 && host.status !== 'error' ? (
              <Button onClick={openCreate}>添加连接</Button>
            ) : undefined
          }
        />
      ) : (
        <div className={styles.masterDetail}>
          <div className={styles.masterList} role="list" aria-label="平台账号">
            {connections.map((connection) => (
              <Button
                className={[styles.masterButton, selected?.id === connection.id ? styles.masterButtonActive : '']
                  .filter(Boolean)
                  .join(' ')}
                variant="ghost"
                onClick={() => setSelectedId(connection.id)}
                key={connection.id}
              >
                <Cable size={16} aria-hidden="true" />
                <span className={styles.masterCopy}>
                  <strong>{connectionLabel(connection.adapterKey, connection.name)}</strong>
                  <small>
                    {connectionLabel(connection.adapterKey, connection.adapter)} · {connection.channels} 个频道
                  </small>
                </span>
                <StatusBadge tone={connectionTone(connection.state)}>{connection.state}</StatusBadge>
              </Button>
            ))}
          </div>

          {selected ? (
            <section className={styles.detailSection}>
              <div className={styles.sectionBar}>
                <div>
                  <div className={styles.sectionHeading}>{connectionLabel(selected.adapterKey, selected.name)}</div>
                  <div className={styles.secondaryText}>{connectionLabel(selected.adapterKey, selected.adapter)}</div>
                </div>
                <StatusBadge tone={connectionTone(selected.state)}>{selected.state}</StatusBadge>
              </div>

              {selected.adapterKey !== 'web' ? (
                <ol className={styles.connectionProgress} aria-label="连接完成进度">
                  {[
                    { label: '连接账号', done: selected.state === '已连接' || selected.state === '已配置' },
                    { label: '发现频道', done: selected.knownChannels.length > 0 },
                    { label: '测试接收', done: selected.receiveTest === '通过' },
                    { label: '测试发送', done: selected.sendTest === '通过' },
                    { label: '绑定智能体', done: bindingCount > 0 },
                  ].map((step, index) => (
                    <li data-done={step.done ? '' : undefined} key={step.label}>
                      <span>
                        {step.done ? <Check size={12} aria-hidden="true" /> : <Circle size={10} aria-hidden="true" />}
                      </span>
                      <small>{step.label}</small>
                      {index < 4 ? <i aria-hidden="true" /> : null}
                    </li>
                  ))}
                </ol>
              ) : null}

              {selected.lastError ? <InlineFeedback tone="error">{selected.lastError}</InlineFeedback> : null}

              <dl className={styles.facts}>
                <dt>最近收到消息</dt>
                <dd>{selected.lastEvent}</dd>
                <dt>已发现频道</dt>
                <dd>{selected.channels} 个</dd>
                {selected.adapterKey !== 'web' ? (
                  <>
                    <dt>应用账号</dt>
                    <dd>{maskedAccount(selected.appId)}</dd>
                    <dt>凭据</dt>
                    <dd>{selected.credentialConfigured ? '已保存' : '未配置'}</dd>
                    <dt>主动发言</dt>
                    <dd>{selected.proactiveSend ? '允许' : '不允许'}</dd>
                  </>
                ) : null}
              </dl>

              {selected.adapterKey === 'web' ? (
                <InlineFeedback tone="info">网页聊天由当前设备管理，不需要配置账号凭据。</InlineFeedback>
              ) : (
                <>
                  <div className={styles.sectionDivider} />
                  <div className={styles.sectionHeading}>连接测试</div>
                  {selected.knownChannels.length > 0 ? (
                    <SelectField
                      label="测试消息发送到"
                      value={selectedTestChannelId}
                      onValueChange={(channelId) =>
                        setTestChannelByConnection((current) => ({ ...current, [selected.id]: channelId }))
                      }
                      options={selected.knownChannels.map((channel) => {
                        const label = friendlyKnownChannelLabel(channel)
                        return {
                          value: channel.id,
                          label: /^QQ (?:群聊|私聊)/u.test(label)
                            ? label
                            : `${label} · ${channel.kind === 'group' ? '群聊' : '私聊'}`,
                        }
                      })}
                    />
                  ) : (
                    <InlineFeedback tone="warning">
                      还没有发现频道。请先在 QQ 群或私聊中向机器人账号发送一条消息。
                    </InlineFeedback>
                  )}
                  <div className={styles.testRows}>
                    <div className={styles.testRow}>
                      <span>
                        <strong>接收消息</strong>
                        <small>{testResultLabel(selected.receiveTest)}</small>
                      </span>
                      <Button
                        size="small"
                        loading={testPending === 'receive'}
                        loadingLabel="测试中…"
                        disabled={testPending !== null}
                        onClick={() => void runTest('receive')}
                      >
                        <Radio size={14} aria-hidden="true" /> 测试接收
                      </Button>
                    </div>
                    <div className={styles.testRow}>
                      <span>
                        <strong>发送消息</strong>
                        <small>{testResultLabel(selected.sendTest)}</small>
                      </span>
                      <Button
                        size="small"
                        loading={testPending === 'send'}
                        loadingLabel="发送中…"
                        disabled={testPending !== null || !sendTargetAvailable}
                        onClick={() => void runTest('send')}
                      >
                        <Send size={14} aria-hidden="true" /> 发送测试消息
                      </Button>
                    </div>
                  </div>
                  <div className={styles.sectionDivider} />
                  <div className={styles.sectionBar}>
                    <div>
                      <div className={styles.sectionHeading}>绑定智能体</div>
                      <div className={styles.secondaryText}>
                        {bindingCount > 0
                          ? `已有 ${bindingCount} 个频道绑定。`
                          : '收发确认后，为频道选择响应的智能体。'}
                      </div>
                    </div>
                    {bindingCount > 0 ? <StatusBadge tone="success">已完成</StatusBadge> : null}
                  </div>
                  {agents.length > 0 ? (
                    <div className={styles.bindingNextStep}>
                      <SelectField
                        label="要配置的智能体"
                        value={bindingAgentId}
                        onValueChange={setBindingAgentId}
                        options={agents.map((agent) => ({ value: agent.id, label: agent.name }))}
                      />
                      <Button
                        disabled={!bindingAgentId || selected.knownChannels.length === 0}
                        onClick={() => void navigate(`/agents/${bindingAgentId}?tab=channels`)}
                      >
                        前往绑定频道 <ArrowRight size={14} aria-hidden="true" />
                      </Button>
                    </div>
                  ) : (
                    <InlineFeedback tone="warning">请先创建智能体，再绑定已发现的频道。</InlineFeedback>
                  )}
                </>
              )}
            </section>
          ) : null}
        </div>
      )}

      <ConfirmDialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open)
          if (!open) {
            setCreateStage('platform')
            setCreateError('')
          }
        }}
        title={createStage === 'platform' ? '选择平台' : `配置${selectedPlatform?.displayName ?? ''}`}
        description={
          createStage === 'platform'
            ? '选择要连接的平台账号。'
            : (selectedPlatform?.description ?? '填写平台账号需要的配置。')
        }
        confirmLabel={createStage === 'platform' ? '继续配置' : '创建连接'}
        onConfirm={async () => {
          if (!selectedPlatform) {
            setCreateError('请选择连接平台。')
            return false
          }
          if (createStage === 'platform') {
            const defaults: Record<string, string | number | boolean> = {}
            for (const [key, property] of Object.entries(selectedPlatform.configSchema.properties)) {
              if (property.type !== 'credential-reference' && property.default !== undefined) {
                defaults[key] = property.default
              }
            }
            setConfiguration(defaults)
            setCredentials({})
            setCreateStage('configuration')
            setCreateError('')
            return false
          }
          setCreateError('')
          try {
            await useProductStore.getState().createConnection({
              adapterKey: selectedPlatform.key,
              configuration,
              credentials,
            })
            notify(`${selectedPlatform.displayName}连接已创建。`, 'success', 'connection-create')
            setConfiguration({})
            setCredentials({})
            setCreateStage('platform')
            return true
          } catch (error) {
            notify(error instanceof Error ? error.message : String(error), 'error', 'connection-create')
            return false
          }
        }}
      >
        <div className={styles.formStack}>
          {createStage === 'platform' ? (
            <SelectField
              label="平台"
              value={selectedPlatformKey}
              onValueChange={(value) => {
                setSelectedPlatformKey(value)
                setCreateError('')
              }}
              options={creatablePlatforms.map((platform) => ({
                value: platform.key,
                label: platform.displayName,
              }))}
            />
          ) : (
            <>
              <Button type="button" size="small" variant="ghost" onClick={() => setCreateStage('platform')}>
                返回选择平台
              </Button>
              {Object.entries(selectedPlatform?.configSchema.properties ?? {}).map(([key, property]) => {
                if (property.type === 'boolean') {
                  return (
                    <SwitchField
                      key={key}
                      label={property.title}
                      description={property.description ?? ''}
                      checked={configuration[key] === true}
                      onCheckedChange={(value) => setConfiguration((current) => ({ ...current, [key]: value }))}
                    />
                  )
                }
                if (property.type === 'credential-reference') {
                  return (
                    <Field key={key} label={property.title} hint="凭据保存后不会在页面中回显。">
                      <Input
                        type="password"
                        autoComplete="new-password"
                        value={credentials[key] ?? ''}
                        onChange={(event) => setCredentials((current) => ({ ...current, [key]: event.target.value }))}
                      />
                    </Field>
                  )
                }
                return (
                  <Field key={key} label={property.title} hint={property.description}>
                    <Input
                      type={property.type === 'number' ? 'number' : 'text'}
                      value={typeof configuration[key] === 'boolean' ? '' : (configuration[key] ?? '')}
                      onChange={(event) =>
                        setConfiguration((current) => ({
                          ...current,
                          [key]: property.type === 'number' ? Number(event.target.value) : event.target.value,
                        }))
                      }
                    />
                  </Field>
                )
              })}
            </>
          )}
          {createError ? <InlineFeedback tone="error">{createError}</InlineFeedback> : null}
        </div>
      </ConfirmDialog>
    </div>
  )
}
