import { CircleCheck, CircleX, Plus, X } from 'lucide-react'
import { useState } from 'react'
import { HostApiContracts, type HostApiResponse, type McpServerForm } from '@nekro-nxt/contracts'
import { useExtensionActivation } from '../../extension-ui/index.js'
import { callHostApi } from '../../host-api-client.js'
import { useProductStore } from '../../product-runtime.js'
import {
  Button,
  Chip,
  Dialog,
  Field,
  IconButton,
  Input,
  Segmented,
  Select,
  Switch,
  Textarea,
  toast,
} from '../../ui-kit/index.js'
import { useProductApi } from '../model/store.js'
import styles from './workshop.module.css'

type Transport = McpServerForm['transport']
type TestResult = HostApiResponse<'testMcpServer'>

interface Row {
  readonly id: number
  readonly name: string
  readonly value: string
  readonly secret: boolean
}

const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/u
const ROW_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/u
const NO_AGENT = '__none__'

/** A tool-name prefix from what the user typed: the URL host or the program name, reduced to the allowed set. */
const suggestName = (transport: Transport, url: string, command: string): string => {
  let source = ''
  if (transport === 'streamable-http') {
    try {
      source = new URL(url).hostname.split('.').filter((part) => !['www', 'mcp', 'api'].includes(part))[0] ?? ''
    } catch {
      source = ''
    }
  } else {
    source =
      command
        .split(/[\\/]/u)
        .at(-1)
        ?.replace(/\.(?:exe|cmd|js|mjs|py)$/iu, '') ?? ''
  }
  return source
    .replace(/[^A-Za-z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 32)
}

let nextRowId = 1
const emptyRow = (): Row => ({ id: nextRowId++, name: '', value: '', secret: true })

function ValueRows({
  label,
  rows,
  namePlaceholder,
  onChange,
}: {
  readonly label: string
  readonly rows: readonly Row[]
  readonly namePlaceholder: string
  readonly onChange: (rows: readonly Row[]) => void
}) {
  const update = (id: number, patch: Partial<Row>) =>
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  return (
    <div className={styles.mcpRows} role="group" aria-label={label}>
      <div className={styles.mcpRowsHead}>
        <span>{label}</span>
        <Button size="small" variant="ghost" icon={<Plus size={14} />} onClick={() => onChange([...rows, emptyRow()])}>
          添加
        </Button>
      </div>
      {rows.map((row, index) => (
        <div key={row.id} className={styles.mcpRow}>
          <Input
            aria-label={`${label} ${index + 1} 名称`}
            placeholder={namePlaceholder}
            value={row.name}
            spellCheck={false}
            aria-invalid={row.name !== '' && !ROW_NAME.test(row.name)}
            onChange={(event) => update(row.id, { name: event.target.value.trim() })}
          />
          <Input
            aria-label={`${label} ${index + 1} 值`}
            type={row.secret ? 'password' : 'text'}
            autoComplete="off"
            value={row.value}
            spellCheck={false}
            onChange={(event) => update(row.id, { value: event.target.value })}
          />
          <Switch
            label={`${label} ${index + 1} 作为凭据保存`}
            checked={row.secret}
            onCheckedChange={(secret) => update(row.id, { secret })}
          />
          <IconButton
            label={`删除${label} ${index + 1}`}
            size="small"
            onClick={() => onChange(rows.filter((item) => item.id !== row.id))}
          >
            <X size={14} />
          </IconButton>
        </div>
      ))}
      {rows.length > 0 ? <span className={styles.mcpRowsHint}>开关打开的值作为凭据保存，不写进扩展。</span> : null}
    </div>
  )
}

/**
 * Adds an MCP server as a no-code extension. Only this administrator form creates local (`stdio`) servers. Credentials
 * typed here are used for the connection test and, when an agent is chosen, stored as that agent's credentials.
 */
export function McpServerDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onCreated: (extensionId: string) => void
}) {
  const api = useProductApi()
  const activation = useExtensionActivation()
  const agents = useProductStore((state) => state.agents)
  const [displayName, setDisplayName] = useState('')
  const [transport, setTransport] = useState<Transport>('streamable-http')
  const [url, setUrl] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [rows, setRows] = useState<readonly Row[]>([])
  const [name, setName] = useState('')
  // Defaults to the first agent once the list has loaded; an explicit choice wins.
  const [agentChoice, setAgentChoice] = useState<string>()
  const agentId = agentChoice ?? agents[0]?.id ?? NO_AGENT
  const [testing, setTesting] = useState(false)
  const [tested, setTested] = useState<TestResult>()
  const [busy, setBusy] = useState(false)

  const serverName = name || suggestName(transport, url, command)
  const filledRows = rows.filter((row) => row.name !== '')
  const urlValid = (() => {
    try {
      return /^https?:$/u.test(new URL(url).protocol)
    } catch {
      return false
    }
  })()
  const valid =
    displayName.trim() !== '' &&
    SERVER_NAME.test(serverName) &&
    filledRows.every((row) => ROW_NAME.test(row.name)) &&
    (transport === 'streamable-http' ? urlValid : command.trim() !== '')

  /** `withSecrets: false` blanks credential values: only the connection test needs them on the server. */
  const form = (withSecrets = true): McpServerForm => {
    const values = filledRows.map(({ name: rowName, value, secret }) => ({
      name: rowName,
      value: secret && !withSecrets ? '' : value,
      secret,
    }))
    return transport === 'stdio'
      ? {
          transport,
          name: serverName,
          command: command.trim(),
          args: args
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== ''),
          env: values,
        }
      : { transport, name: serverName, url: url.trim(), headers: values }
  }

  const reset = () => {
    setDisplayName('')
    setUrl('')
    setCommand('')
    setArgs('')
    setRows([])
    setName('')
    setAgentChoice(undefined)
    setTested(undefined)
  }

  const test = async () => {
    setTesting(true)
    setTested(undefined)
    try {
      setTested(await callHostApi(HostApiContracts.testMcpServer, {}, { server: form() }))
    } catch (error) {
      setTested({ ok: false, message: error instanceof Error ? error.message : String(error), tools: [] })
    } finally {
      setTesting(false)
    }
  }

  const create = async () => {
    setBusy(true)
    try {
      const created = await callHostApi(
        HostApiContracts.createMcpExtension,
        {},
        { displayName: displayName.trim(), description: '', server: form(false) },
      )
      await api.getState().refreshHost()
      onOpenChange(false)
      reset()
      onCreated(created.extensionId)
      if (agentId === NO_AGENT) {
        toast('已添加，尚未启用')
        return
      }
      const enabled = await activation.setActive({
        extensionId: created.extensionId,
        agentId,
        enabled: true,
        revisionId: created.revisionId,
      })
      if (!enabled) {
        toast('已添加，尚未启用')
        return
      }
      const typed = new Map(filledRows.map((row) => [row.name, row.value]))
      const secrets = Object.fromEntries(
        created.secretFields.flatMap(({ key, name: rowName }) => {
          const value = typed.get(rowName)
          return value === undefined || value === '' ? [] : [[key, value]]
        }),
      )
      if (Object.keys(secrets).length > 0) {
        await api.getState().updateExtensionConfig({ extensionId: created.extensionId, agentId, config: {}, secrets })
      }
      toast('已添加并启用')
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {activation.dialog}
      <Dialog
        open={open}
        onOpenChange={(next) => !busy && onOpenChange(next)}
        title="添加 MCP 服务"
        wide
        actions={
          <>
            <Button onClick={() => void test()} busy={testing} disabled={!valid || busy}>
              测试连接
            </Button>
            <Button onClick={() => onOpenChange(false)} disabled={busy}>
              取消
            </Button>
            <Button variant="primary" busy={busy} disabled={!valid} onClick={() => void create()}>
              添加
            </Button>
          </>
        }
      >
        <div className={styles.mcpForm}>
          <Field label="名称">
            <Input
              value={displayName}
              placeholder="例如：团队知识库"
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </Field>
          <Segmented
            label="连接方式"
            value={transport}
            onChange={(next) => {
              setTransport(next)
              setTested(undefined)
            }}
            options={[
              { value: 'streamable-http', label: '远程服务' },
              { value: 'stdio', label: '本机程序' },
            ]}
          />
          {transport === 'streamable-http' ? (
            <Field label="地址" error={url !== '' && !urlValid ? '需要 http:// 或 https:// 地址' : undefined}>
              <Input
                value={url}
                placeholder="https://mcp.example.com/mcp"
                spellCheck={false}
                onChange={(event) => setUrl(event.target.value.trim())}
              />
            </Field>
          ) : (
            <>
              <Field label="命令" hint="在运行 NekroNXT 的这台机器上执行，工作目录是智能体的工作区">
                <Input
                  value={command}
                  placeholder="npx"
                  spellCheck={false}
                  onChange={(event) => setCommand(event.target.value)}
                />
              </Field>
              <Field label="参数" hint="每行一个">
                <Textarea
                  value={args}
                  rows={2}
                  spellCheck={false}
                  placeholder={'-y\n@example/mcp-server'}
                  onChange={(event) => setArgs(event.target.value)}
                />
              </Field>
            </>
          )}
          <ValueRows
            label={transport === 'stdio' ? '环境变量' : '请求头'}
            namePlaceholder={transport === 'stdio' ? 'API_KEY' : 'Authorization'}
            rows={rows}
            onChange={setRows}
          />
          <Field label="工具前缀" hint={`工具名形如 mcp__${serverName || '前缀'}__工具名；只能用字母、数字、-、_`}>
            <Input
              value={name}
              placeholder={suggestName(transport, url, command) || 'example'}
              spellCheck={false}
              aria-invalid={name !== '' && !SERVER_NAME.test(name)}
              onChange={(event) => setName(event.target.value.trim())}
            />
          </Field>
          <Field label="启用到">
            <Select
              aria-label="启用到"
              value={agentId}
              onValueChange={setAgentChoice}
              options={[
                ...agents.map((agent) => ({ value: agent.id, label: agent.name })),
                { value: NO_AGENT, label: '暂不启用' },
              ]}
            />
          </Field>
          {tested ? (
            <div
              className={styles.mcpTest}
              data-ok={tested.ok}
              ref={(node) => node?.scrollIntoView({ block: 'nearest' })}
            >
              <span className={styles.mcpTestHead}>
                {tested.ok ? <CircleCheck size={15} /> : <CircleX size={15} />}
                {tested.message}
              </span>
              {tested.tools.length > 0 ? (
                <div className={styles.mcpTools}>
                  {tested.tools.map((tool) => (
                    <Chip key={tool.name}>{tool.name}</Chip>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </Dialog>
    </>
  )
}
