import {
  communityPersonaReviewLabel,
  HostApiContracts,
  promptDocumentPlainText,
  type CommunityMyPersona,
  type HostApiResponse,
} from '@nekro-nxt/contracts'
import { useEffect, useState } from 'react'
import { callHostApi } from '../../host-api-client.js'
import type { AgentSummary } from '../../product-runtime.js'
import {
  Banner,
  Button,
  Chip,
  Dialog,
  Field,
  InfoTip,
  Input,
  Select,
  SwitchRow,
  Textarea,
  toast,
} from '../../ui-kit/index.js'
import { useGo } from '../model/nav.js'
import { errorMessage, useCommunityStatus } from './community-model.js'
import { parseTags, prepareShareAvatar } from './persona-model.js'
import styles from './personas.module.css'

type Mine = HostApiResponse<'listCommunityMyPersonas'>
const NEW = 'new'

/**
 * 把智能体的设定分享为社区人设。预填名称、设定与头像，作者补充简介、介绍与标签；这个智能体发布过时默认更新
 * 原来的人设。社区审查通过后才公开。
 */
export function PersonaPublishDialog({
  agent,
  open,
  onOpenChange,
}: {
  readonly agent: AgentSummary
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const navigate = useGo()
  const community = useCommunityStatus(open)
  const account = community.status?.account ?? null
  const [mine, setMine] = useState<Mine>()
  const [mineError, setMineError] = useState<string>()
  const [personaId, setPersonaId] = useState(NEW)
  const [name, setName] = useState('')
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  const [tags, setTags] = useState('')
  const [persona, setPersona] = useState('')
  const [notes, setNotes] = useState('')
  const [withAvatar, setWithAvatar] = useState(true)
  const [busy, setBusy] = useState(false)
  const [published, setPublished] = useState<CommunityMyPersona>()
  const avatarUrl = agent.appearance?.avatarUrl

  useEffect(() => {
    if (!open) return
    setPublished(undefined)
    setName(agent.name)
    setSummary('')
    setDescription('')
    setTags('')
    setPersona(promptDocumentPlainText(agent.personaDocument))
    setNotes('')
    setWithAvatar(Boolean(avatarUrl))
    setPersonaId(NEW)
  }, [open, agent.id])

  useEffect(() => {
    if (!open || !account) return
    let cancelled = false
    callHostApi(HostApiContracts.listCommunityMyPersonas, {}, undefined)
      .then((result) => {
        if (cancelled) return
        setMine(result)
        setMineError(undefined)
        const linked = (result.agentLinks as Readonly<Record<string, string>>)[agent.id]
        if (linked) choose(linked, result)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setMineError(errorMessage(caught))
      })
    return () => {
      cancelled = true
    }
  }, [open, account?.handle, agent.id])

  /** 选择更新已有的人设时，预填它在社区上的简介与标签；介绍只有公开后才能读取。 */
  const choose = (id: string, source = mine) => {
    setPersonaId(id)
    const existing = source?.items.find((item) => item.id === id)
    if (!existing) return
    setSummary(existing.summary)
    setTags(existing.tags.join('，'))
    callHostApi(HostApiContracts.getCommunityPersona, { personaId: existing.id }, undefined)
      .then((detail) => setDescription((current) => current || detail.description))
      .catch(() => undefined)
  }

  const updating = personaId !== NEW
  const tagList = parseTags(tags)
  const ready = Boolean(name.trim() && summary.trim() && persona.trim()) && tagList.length <= 16

  const publish = async () => {
    setBusy(true)
    try {
      const avatar = withAvatar && avatarUrl ? await prepareShareAvatar(avatarUrl) : undefined
      setPublished(
        await callHostApi(
          HostApiContracts.publishCommunityPersona,
          {},
          {
            agentId: agent.id,
            ...(updating ? { personaId } : {}),
            name: name.trim(),
            summary: summary.trim(),
            description: description.trim(),
            tags: tagList,
            persona: persona.trim(),
            ...(updating && notes.trim() ? { notes: notes.trim() } : {}),
            ...(avatar ? { avatar } : {}),
          },
        ),
      )
    } catch (caught) {
      toast(errorMessage(caught), { tone: 'bad' })
      void community.refresh()
    } finally {
      setBusy(false)
    }
  }

  const close = () => {
    if (!busy) onOpenChange(false)
  }

  if (published) {
    const label = communityPersonaReviewLabel(published.latestRevision.reviewStatus)
    return (
      <Dialog
        open={open}
        onOpenChange={(next) => !next && close()}
        title={updating ? '已更新社区人设' : '已分享到社区'}
        actions={
          <>
            <Button onClick={close}>完成</Button>
            <Button
              variant="primary"
              onClick={() => {
                close()
                navigate('/community/mine')
              }}
            >
              查看我的发布
            </Button>
          </>
        }
      >
        <p className={styles.review}>
          <Chip tone={label.tone}>{label.label}</Chip>
        </p>
        <p>
          {published.latestRevision.reviewStatus === 'approved'
            ? '审查已通过，社区里的所有人都能看到并安装它。'
            : published.latestRevision.reviewStatus === 'rejected'
              ? '这次分享没有通过审查，不会公开。修改设定后可以再次分享。'
              : '社区审查通过后会公开，通常几分钟内完成。'}
        </p>
      </Dialog>
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && close()}
      title="分享人设到社区"
      wide
      actions={
        account ? (
          <>
            <Button onClick={close} disabled={busy}>
              取消
            </Button>
            <Button variant="primary" busy={busy} disabled={!ready} onClick={() => void publish()}>
              {updating ? '更新' : '分享'}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={close}>取消</Button>
            <Button
              variant="primary"
              onClick={() => void community.signIn().catch((caught) => toast(errorMessage(caught), { tone: 'bad' }))}
            >
              {community.waiting ? '重新打开授权页' : '登录社区'}
            </Button>
          </>
        )
      }
    >
      {community.status === undefined ? (
        <p>正在读取社区账号…</p>
      ) : !account ? (
        <>
          <p>分享前先登录社区，登录会在浏览器中完成。</p>
          {community.waiting ? <Banner tone="info">已在浏览器打开授权页，授权后这里会自动更新。</Banner> : null}
        </>
      ) : (
        <div className={styles.dialogBody}>
          <p className={styles.dialogNote}>
            以 @{account.handle} 分享。只分享名称、头像和设定，不含模型、能力与扩展。
            <InfoTip label="审查与公开">审核通过后公开，之后更新会重新审核。</InfoTip>
          </p>
          {mineError ? <Banner tone="bad">{mineError}</Banner> : null}
          {mine && mine.items.length > 0 ? (
            <Field label="分享为">
              <Select
                aria-label="分享为"
                value={personaId}
                options={[
                  { value: NEW, label: '新的人设' },
                  ...mine.items.map((item) => ({ value: item.id, label: `更新「${item.name}」` })),
                ]}
                onValueChange={(value) => (value === NEW ? setPersonaId(NEW) : choose(value))}
              />
            </Field>
          ) : null}
          <div className={styles.formRow}>
            <Field label="名称">
              <Input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
            </Field>
            <Field label="标签" hint="用逗号分隔，最多 16 个">
              <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="比如：陪伴，读书" />
            </Field>
          </div>
          <Field label="简介" hint="一句话说明它是谁">
            <Input value={summary} maxLength={200} onChange={(event) => setSummary(event.target.value)} />
          </Field>
          <Field label="介绍" hint="可选，支持 Markdown。适合什么频道、有什么特点">
            <Textarea
              value={description}
              rows={4}
              maxLength={20_000}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <Field label="人设正文">
            <Textarea
              value={persona}
              rows={8}
              maxLength={64 * 1024}
              onChange={(event) => setPersona(event.target.value)}
            />
          </Field>
          {updating ? (
            <Field label="更新说明" hint="可选">
              <Input value={notes} maxLength={2000} onChange={(event) => setNotes(event.target.value)} />
            </Field>
          ) : null}
          {avatarUrl ? (
            <SwitchRow
              title="附上头像"
              description={updating ? '关闭时保留社区上原来的头像' : undefined}
              checked={withAvatar}
              onCheckedChange={setWithAvatar}
              trailing={<img src={avatarUrl} alt="" className={styles.avatarPreview} />}
            />
          ) : null}
        </div>
      )}
    </Dialog>
  )
}
