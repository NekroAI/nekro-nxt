import { useMemo, useState } from 'react'
import { promptDocumentFromText, type PromptDocumentV1 } from '@nekro-nxt/contracts'
import { PromptReferenceEditor } from '../../components/prompt-reference-editor.js'
import { AddModelProviderForm } from '../../llm-settings.js'
import { useProductStore } from '../../product-runtime.js'
import {
  Banner,
  Button,
  Chip,
  Input,
  MainContent,
  PropertyGroup,
  PropertyList,
  PropertyRow,
  Select,
  toast,
} from '../../ui-kit/next/index.js'
import { useGo } from '../model/nav.js'
import { useProductApi } from '../model/store.js'
import { agentModelKey, createAgentDraft } from './agent-create-draft.js'
import { supportsImages } from './agent-draft.js'
import styles from './agents.module.css'

export function AgentCreate() {
  const api = useProductApi()
  const navigate = useGo()
  const models = useProductStore((state) => state.models)
  const availability = useProductStore((state) => state.capabilityAvailability)
  const initial = useMemo(
    () => createAgentDraft(models, availability.webSearch.available),
    [models, availability.webSearch.available],
  )
  const [name, setName] = useState('')
  const [persona, setPersona] = useState<{ readonly document: PromptDocumentV1; readonly text: string }>(() => ({
    document: promptDocumentFromText(''),
    text: '',
  }))
  const [modelKey, setModelKey] = useState(initial.selectedModelKey)
  const [creating, setCreating] = useState(false)
  const model = models.find((item) => agentModelKey(item) === (modelKey || initial.selectedModelKey))

  const create = async () => {
    if (!model || !name.trim()) return
    setCreating(true)
    try {
      const created = await api.getState().createAgent({
        name: name.trim(),
        persona: persona.text,
        personaDocument: persona.document,
        model,
        capabilities: initial.capabilities,
      })
      toast(`${name.trim()}已创建`)
      navigate(`/channels/${created.channelId}`)
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
      setCreating(false)
    }
  }

  return (
    <MainContent width="readable">
      <form
        className={styles.create}
        onSubmit={(event) => {
          event.preventDefault()
          void create()
        }}
      >
        <h1 className={styles.createTitle}>新建智能体</h1>

        <PropertyGroup title="基本信息">
          <PropertyList>
            <PropertyRow label="名称" htmlFor="agent-create-name" description="频道里显示的名字，之后可以改">
              <Input
                id="agent-create-name"
                className={styles.nameInput}
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={40}
                placeholder="比如：小奈"
                autoFocus
              />
            </PropertyRow>
            {models.length > 0 ? (
              <PropertyRow
                label="主模型"
                description="负责理解消息、思考和回复"
                badge={
                  model ? (
                    <Chip tone={supportsImages(model) ? 'ok' : 'neutral'}>
                      {supportsImages(model) ? '能看图' : '不能看图'}
                    </Chip>
                  ) : undefined
                }
              >
                <Select
                  className={styles.modelSelect}
                  aria-label="主模型"
                  value={model ? agentModelKey(model) : ''}
                  {...(model ? {} : { placeholder: '选择模型' })}
                  options={models.map((item) => ({
                    value: agentModelKey(item),
                    label: `${item.providerName} · ${item.name}`,
                  }))}
                  onValueChange={(value) => setModelKey(value)}
                />
              </PropertyRow>
            ) : null}
          </PropertyList>
          {models.length === 0 ? (
            <div className={styles.createProvider}>
              <Banner tone="warn">当前没有可用模型。请先保存一个供应商。</Banner>
              {/* Saving here keeps the name and persona already typed above. */}
              <AddModelProviderForm
                onSaved={() => {
                  const first = api.getState().models[0]
                  if (first) setModelKey(agentModelKey(first))
                }}
              />
            </div>
          ) : null}
        </PropertyGroup>

        <PropertyGroup title="设定" description="一两句话就够，之后随时可以改">
          <PromptReferenceEditor
            value={persona.document}
            label="设定"
            description="她是谁、怎么说话、在群里负责什么"
            placeholder="她是谁、怎么说话、在群里负责什么"
            onChange={(document, text) => setPersona({ document, text })}
          />
        </PropertyGroup>

        <div className={styles.createActions}>
          <Button variant="ghost" onClick={() => window.history.back()}>
            取消
          </Button>
          <Button type="submit" variant="primary" busy={creating} disabled={!name.trim() || !model}>
            创建并开始对话
          </Button>
        </div>
      </form>
    </MainContent>
  )
}
