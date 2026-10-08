import { HostApiContracts, type CommunityPersonaDetail } from '@nekro-nxt/contracts'
import { useEffect, useMemo, useState } from 'react'
import { callHostApi } from '../../host-api-client.js'
import { useProductStore } from '../../product-runtime.js'
import {
  Banner,
  Button,
  Dialog,
  Field,
  InfoTip,
  Input,
  Segmented,
  Select,
  SwitchRow,
  toast,
} from '../../ui-kit/index.js'
import { agentModelKey, createAgentDraft } from '../agents/agent-create-draft.js'
import { useGo } from '../model/nav.js'
import { useProductApi } from '../model/store.js'
import { errorMessage } from './community-model.js'
import styles from './personas.module.css'

type Target = 'new' | 'replace'

/**
 * 安装社区人设：新建一个智能体（名称、模型可改），或替换现有智能体的设定（保存为新的一次配置，原设定可恢复）。
 * 安装请求带上当前看到的修订，作者刚更新过时 Host 会拒绝，避免装入没看过的内容。
 */
export function PersonaInstallDialog({
  persona,
  open,
  onOpenChange,
}: {
  readonly persona: CommunityPersonaDetail
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const navigate = useGo()
  const api = useProductApi()
  const models = useProductStore((state) => state.models)
  const agents = useProductStore((state) => state.agents)
  const webSearch = useProductStore((state) => state.capabilityAvailability.webSearch.available)
  const initialModelKey = useMemo(() => createAgentDraft(models, webSearch).selectedModelKey, [models, webSearch])
  const [target, setTarget] = useState<Target>('new')
  const [name, setName] = useState('')
  const [modelKey, setModelKey] = useState('')
  const [agentId, setAgentId] = useState('')
  const [rename, setRename] = useState(false)
  const [useAvatar, setUseAvatar] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setTarget('new')
    setName([...persona.name].slice(0, 40).join(''))
    setModelKey('')
    setAgentId('')
    setRename(false)
  }, [open, persona.id])

  // 新建智能体默认用人设头像；替换现有智能体时默认保留原头像（换掉的头像不进版本，无法恢复），需要时再勾选。
  useEffect(() => {
    if (open) setUseAvatar(target === 'new' && persona.avatarUrl !== null)
  }, [open, target, persona.avatarUrl])

  const model = models.find((item) => agentModelKey(item) === (modelKey || initialModelKey))
  const agent = agents.find((item) => item.id === agentId)
  const hasAvatar = persona.avatarUrl !== null
  const ready = target === 'new' ? Boolean(name.trim() && model) : Boolean(agent?.currentRevisionId)

  const install = async () => {
    setBusy(true)
    try {
      const result = await callHostApi(
        HostApiContracts.installCommunityPersona,
        { personaId: persona.id },
        target === 'new'
          ? {
              target: 'new',
              expectedRevisionId: persona.revision.id,
              displayName: name.trim(),
              model: { provider: model?.provider ?? '', model: model?.id ?? '' },
              useAvatar: hasAvatar && useAvatar,
            }
          : {
              target: 'replace',
              expectedRevisionId: persona.revision.id,
              agentId: agent?.id ?? '',
              expectedCurrentRevisionId: agent?.currentRevisionId ?? '',
              ...(rename ? { displayName: [...persona.name].slice(0, 80).join('') } : {}),
              useAvatar: hasAvatar && useAvatar,
            },
      )
      // 先读到新的智能体再跳转，否则智能体页会因找不到它而退回列表。
      await api.getState().refreshHost()
      onOpenChange(false)
      toast(target === 'new' ? `已创建「${name.trim()}」` : `已替换「${agent?.name ?? ''}」的设定`)
      if (result.avatar === 'failed') toast('头像没有下载成功，可以稍后再换。', { tone: 'bad' })
      navigate(`/agents/${result.agentId}`)
    } catch (caught) {
      toast(errorMessage(caught), { tone: 'bad' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !busy && onOpenChange(next)}
      title={`安装「${persona.name}」`}
      actions={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" busy={busy} disabled={!ready} onClick={() => void install()}>
            {target === 'new' ? '创建智能体' : '替换设定'}
          </Button>
        </>
      }
    >
      <div className={styles.dialogBody}>
        <Segmented<Target>
          label="安装方式"
          value={target}
          onChange={setTarget}
          options={
            agents.length > 0
              ? [
                  { value: 'new', label: '新建智能体' },
                  { value: 'replace', label: '替换现有智能体的设定' },
                ]
              : [{ value: 'new', label: '新建智能体' }]
          }
        />
        {target === 'new' ? (
          <>
            <Field label="名称">
              <Input value={name} maxLength={40} onChange={(event) => setName(event.target.value)} />
            </Field>
            {models.length > 0 ? (
              <Field label="主模型">
                <Select
                  aria-label="主模型"
                  value={model ? agentModelKey(model) : ''}
                  {...(model ? {} : { placeholder: '选择模型' })}
                  options={models.map((item) => ({
                    value: agentModelKey(item),
                    label: `${item.providerName} · ${item.name}`,
                  }))}
                  onValueChange={setModelKey}
                />
              </Field>
            ) : (
              <Banner tone="warn">当前没有可用模型。请先在「设置 → 模型」中添加供应商。</Banner>
            )}
          </>
        ) : (
          <>
            <Field label="智能体">
              <Select
                aria-label="要替换设定的智能体"
                value={agentId}
                placeholder="选择智能体"
                options={agents.map((item) => ({ value: item.id, label: item.name }))}
                onValueChange={setAgentId}
              />
            </Field>
            <SwitchRow
              title={`同时改名为「${persona.name}」`}
              checked={rename}
              onCheckedChange={setRename}
              disabled={!agent}
            />
            <p className={styles.dialogNote}>
              模型、能力与频道不变，原设定可以在智能体的「恢复之前的配置」中找回。
              <InfoTip label="恢复原来的设定">
                在智能体页选择「更多 → 恢复之前的配置」，可以回到替换前的设定。头像不属于版本，换掉后需要重新上传。
              </InfoTip>
            </p>
          </>
        )}
        {hasAvatar ? (
          <SwitchRow
            title={target === 'new' ? '使用人设头像' : '同时应用人设头像'}
            checked={useAvatar}
            onCheckedChange={setUseAvatar}
          />
        ) : null}
      </div>
    </Dialog>
  )
}
