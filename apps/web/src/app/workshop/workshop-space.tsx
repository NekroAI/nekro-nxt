import { useGo } from '../model/nav.js'
import { Hammer, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { Link, Navigate, useLocation } from 'react-router-dom'
import { HostApiContracts, type HostApiResponse } from '@nekro-nxt/contracts'
import { callHostApi } from '../../host-api-client.js'
import { useHostActions, useProductStore } from '../../product-runtime.js'
import {
  AgentAvatar,
  Button,
  Chip,
  Dialog,
  EmptyState,
  Field,
  FileChooser,
  IconButton,
  Input,
  SelectionList,
  StatusDot,
  toast,
} from '../../ui-kit/next/index.js'
import { relativeTime } from '../channels/timeline-model.js'
import { agentHue } from '../model/identity.js'
import { useCrumb } from '../shell/crumb.js'
import { ExtensionView } from './extension-view.js'
import { TaskView } from './task-view.js'
import { SLUG_PATTERN, extensionUsage, isTaskOpen, scopeLabel, sortTasks, taskStatus } from './workshop-model.js'
import styles from './workshop.module.css'

type Inspection = HostApiResponse<'inspectExtensionImport'>

const parse = (path: string): { readonly kind: 'task' | 'extension'; readonly id: string } | undefined => {
  const match = /^\/workshop\/(tasks|extensions)\/([^/]+)/u.exec(path)
  return match
    ? { kind: match[1] === 'tasks' ? 'task' : 'extension', id: decodeURIComponent(match[2] ?? '') }
    : undefined
}

export default function WorkshopSpace() {
  const { pathname } = useLocation()
  const navigate = useGo()
  const hostStatus = useProductStore((state) => state.host.status)
  const tasks = sortTasks(useProductStore((state) => state.authoringTasks))
  const extensions = useProductStore((state) => state.extensions)
  const agents = useProductStore((state) => state.agents)
  const route = parse(pathname)
  const task = route?.kind === 'task' ? tasks.find((item) => item.id === route.id) : undefined
  const extension = route?.kind === 'extension' ? extensions.find((item) => item.id === route.id) : undefined
  useCrumb('工坊', task?.title ?? extension?.name)

  if (!route && hostStatus !== 'initializing') {
    const first = tasks.find(isTaskOpen) ?? tasks[0]
    if (first) return <Navigate to={`/workshop/tasks/${first.id}`} replace />
    if (extensions[0]) return <Navigate to={`/workshop/extensions/${extensions[0].id}`} replace />
  }
  if (route && !task && !extension && hostStatus === 'ready') return <Navigate to="/workshop" replace />

  const selected = task ? `task:${task.id}` : extension ? `extension:${extension.id}` : undefined
  const agentOf = (id: string) => agents.find((item) => item.id === id)

  return (
    <div className={styles.space}>
      <aside className={styles.list} aria-label="工坊">
        <div className={styles.listHead}>
          <h2>工坊</h2>
          <ImportButton onImported={(id) => navigate(`/workshop/extensions/${id}`)} />
        </div>
        <div className={styles.listBody}>
          <SelectionList selectedKey={selected}>
            {tasks.length > 0 ? <div className={styles.group}>创造任务</div> : null}
            {tasks.map((item) => {
              const status = taskStatus(item)
              const agent = agentOf(item.agentId)
              const key = `task:${item.id}`
              return (
                <Link
                  key={key}
                  to={`/workshop/tasks/${item.id}`}
                  className={styles.row}
                  data-selected={key === selected}
                  aria-current={key === selected ? 'page' : undefined}
                >
                  {agent ? (
                    <AgentAvatar
                      name={agent.name}
                      hue={agentHue(agent)}
                      size="sm"
                      live={isTaskOpen(item) && status.tone === 'accent'}
                    />
                  ) : (
                    <span className={styles.rowGlyph}>
                      <Hammer size={14} />
                    </span>
                  )}
                  <span className={styles.rowName}>{item.title}</span>
                  <span className={styles.rowState}>
                    <StatusDot tone={status.tone} />
                  </span>
                  <span className={styles.rowSub}>
                    {status.label} · {relativeTime(item.updatedAt)}
                  </span>
                </Link>
              )
            })}
            {extensions.length > 0 ? <div className={styles.group}>本地扩展</div> : null}
            {extensions.map((item) => {
              const usage = extensionUsage(item)
              const key = `extension:${item.id}`
              return (
                <Link
                  key={key}
                  to={`/workshop/extensions/${item.id}`}
                  className={styles.row}
                  data-selected={key === selected}
                  aria-current={key === selected ? 'page' : undefined}
                >
                  <span className={styles.rowGlyph} data-scope={item.scope}>
                    {[...item.name][0] ?? '扩'}
                  </span>
                  <span className={styles.rowName}>{item.name}</span>
                  <span className={styles.rowState}>
                    <StatusDot tone={usage.tone} />
                  </span>
                  <span className={styles.rowSub}>
                    {scopeLabel[item.scope]} · r{item.revision}
                  </span>
                </Link>
              )
            })}
          </SelectionList>
        </div>
      </aside>
      {task ? (
        <TaskView key={task.id} task={task} />
      ) : extension ? (
        <ExtensionView key={extension.id} extension={extension} />
      ) : hostStatus === 'initializing' ? (
        <div />
      ) : (
        <Start />
      )}
    </div>
  )
}

/** Nothing made yet: creation starts by talking to an agent that may create, in one of its channels. */
function Start() {
  const agents = useProductStore((state) => state.agents)
  const navigate = useGo()
  const creators = agents.filter((agent) => agent.capabilities.dynamicCreation)
  return (
    <div className={styles.start}>
      <EmptyState
        icon={<Hammer size={22} />}
        title="在频道里请智能体做一个新能力"
        action={
          <div className={styles.creators}>
            {creators.length > 0 ? (
              creators.map((agent) => (
                <Button
                  key={agent.id}
                  disabled={!agent.channels[0]}
                  onClick={() => agent.channels[0] && navigate(`/channels/${agent.channels[0]}`)}
                >
                  <AgentAvatar name={agent.name} hue={agentHue(agent)} size="xs" />
                  {agent.name}
                </Button>
              ))
            ) : (
              <>
                <span className={styles.faint}>还没有智能体开启「动态创造」</span>
                <Button onClick={() => navigate(agents[0] ? `/agents/${agents[0].id}` : '/agents/new')}>
                  {agents[0] ? '去开启' : '新建智能体'}
                </Button>
              </>
            )}
          </div>
        }
      />
    </div>
  )
}

function ImportButton({ onImported }: { readonly onImported: (extensionId: string) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const hostActions = useHostActions()
  const [inspection, setInspection] = useState<Inspection>()
  const [slug, setSlug] = useState('')
  const [busy, setBusy] = useState(false)

  const inspect = async (file: File) => {
    try {
      const result = await callHostApi(
        HostApiContracts.inspectExtensionImport,
        {},
        { bytes: new Uint8Array(await file.arrayBuffer()) },
      )
      setInspection(result)
      setSlug(result.slugConflict ? `${result.slug}-2` : result.slug)
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
    }
  }
  const commit = async () => {
    if (!inspection) return
    setBusy(true)
    try {
      const result = await hostActions['extensions.commitImport']({
        token: inspection.token,
        ...(inspection.slugConflict ? { localSlug: slug } : {}),
      })
      setInspection(undefined)
      toast(result.idempotent ? '相同版本已存在' : '已导入，尚未启用')
      onImported(result.extensionId)
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <IconButton label="导入扩展" size="small" onClick={() => input.current?.click()}>
        <Upload size={15} />
      </IconButton>
      <FileChooser ref={input} accept=".nxt-extension,.zip,application/zip" onFile={(file) => void inspect(file)} />
      <Dialog
        open={inspection !== undefined}
        onOpenChange={(open) => !open && !busy && setInspection(undefined)}
        title={`导入「${inspection?.displayName ?? ''}」`}
        actions={
          <>
            <Button onClick={() => setInspection(undefined)} disabled={busy}>
              取消
            </Button>
            <Button
              variant="primary"
              busy={busy}
              disabled={inspection?.slugConflict === true && !SLUG_PATTERN.test(slug)}
              onClick={() => void commit()}
            >
              {inspection?.idempotent ? '确认' : '导入'}
            </Button>
          </>
        }
      >
        {inspection ? (
          <>
            <div>
              <Chip>{scopeLabel[inspection.scope]}</Chip>
            </div>
            <p>{inspection.idempotent ? '本机已有完全相同的版本。' : '导入后不会自动启用。'}</p>
            {inspection.slugConflict ? (
              <Field label="标识" hint="原标识已被占用">
                <Input value={slug} spellCheck={false} onChange={(event) => setSlug(event.target.value.trim())} />
              </Field>
            ) : null}
          </>
        ) : null}
      </Dialog>
    </>
  )
}
