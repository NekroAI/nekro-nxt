import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { promptDocumentFromText, type PromptDocumentV1 } from '@nekro-nxt/contracts'
import { PromptReferenceEditor } from '../../components/prompt-reference-editor.js'
import { agentModelKey, createAgentDraft } from '../../pages/agent-create-draft.js'
import { useProductStore } from '../../product-runtime.js'
import { Banner, Button, Field, Input, Select, toast } from '../../ui-kit/next/index.js'
import { useProductApi } from '../model/store.js'
import styles from './agents.module.css'

export function AgentCreate() {
  const api = useProductApi()
  const navigate = useNavigate()
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
    <form
      className={styles.create}
      onSubmit={(event) => {
        event.preventDefault()
        void create()
      }}
    >
      <div className={styles.createHead}>
        <h1>新建智能体</h1>
      </div>
      {models.length === 0 ? (
        <Banner
          tone="warn"
          action={
            <Button size="small" onClick={() => navigate('/settings/models')}>
              添加模型
            </Button>
          }
        >
          还没有可用模型
        </Banner>
      ) : null}
      <Field label="名称">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={40}
          placeholder="比如：小奈"
          autoFocus
        />
      </Field>
      <PromptReferenceEditor
        value={persona.document}
        label="设定"
        description="一两句话就够，之后随时可以改。"
        placeholder="她是谁、怎么说话、在群里负责什么"
        onChange={(document, text) => setPersona({ document, text })}
      />
      <Field label="模型">
        <Select
          value={model ? agentModelKey(model) : ''}
          {...(model ? {} : { placeholder: '选择模型' })}
          options={models.map((item) => ({ value: agentModelKey(item), label: `${item.providerName} · ${item.name}` }))}
          onChange={(event) => setModelKey(event.target.value)}
          disabled={models.length === 0}
        />
      </Field>
      <div className={styles.createActions}>
        <Button variant="ghost" onClick={() => navigate(-1)}>
          取消
        </Button>
        <Button type="submit" variant="primary" busy={creating} disabled={!name.trim() || !model}>
          创建并开始对话
        </Button>
      </div>
    </form>
  )
}
