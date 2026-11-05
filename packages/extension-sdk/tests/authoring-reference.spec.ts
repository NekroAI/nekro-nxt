import { describe, expect, it } from 'vitest'
import {
  NEKRO_NXT_EXTENSION_AUTHORING_REFERENCE as reference,
  NEKRO_NXT_EXTENSION_REFERENCE_TOPICS,
  findNekroNxtExtensionReferenceTopic,
  renderNekroNxtExtensionDevelopmentOverview,
  renderNekroNxtExtensionDevelopmentSkill,
  renderNekroNxtExtensionReferenceTopic,
} from '../src/index.js'

/** The skill body is read whenever an agent develops an extension; topics are read one or a few at a time. */
const OVERVIEW_BUDGET = 4000
const TOPIC_BUDGET = 8000

const overview = renderNekroNxtExtensionDevelopmentOverview()
const topics = NEKRO_NXT_EXTENSION_REFERENCE_TOPICS.map((topic) => ({
  ...topic,
  text: renderNekroNxtExtensionReferenceTopic(topic.id),
}))

/** Every fact the reference data carries, as it is written into the skill. */
const referenceFacts = (): readonly string[] => [
  reference.hostCapabilities.declaration,
  ...reference.hostCapabilities.services,
  ...reference.hostCapabilities.rules,
  ...reference.governanceRules,
  ...reference.recoveryRules,
  ...reference.ui.designContract.compositionRules,
  ...reference.ui.designContract.responsibilities.flatMap(({ provided, forbidden }) => [...provided, ...forbidden]),
  ...reference.ui.components.map((name) => `\`${name}\`：${reference.ui.componentProps[name]}`),
  ...Object.values(reference.examples),
]

describe('extension authoring reference', () => {
  it('keeps the skill overview within its budget', () => {
    expect(overview.length).toBeLessThanOrEqual(OVERVIEW_BUDGET)
  })

  it('keeps every topic within its budget', () => {
    const oversized = topics
      .filter((topic) => topic.text.length > TOPIC_BUDGET)
      .map((topic) => `${topic.id}: ${topic.text.length}`)
    expect(oversized).toEqual([])
  })

  it('places every fact of the reference in the overview or a topic', () => {
    const corpus = [overview, ...topics.map((topic) => topic.text)].join('\n')
    expect(referenceFacts().filter((fact) => !corpus.includes(fact))).toEqual([])
  })

  it('lists every topic in the overview', () => {
    for (const { id, title } of NEKRO_NXT_EXTENSION_REFERENCE_TOPICS) expect(overview).toContain(`\`${id}\` ${title}：`)
    expect(new Set(NEKRO_NXT_EXTENSION_REFERENCE_TOPICS.map((topic) => topic.id)).size).toBe(topics.length)
  })

  it('still renders the whole reference as one document', () => {
    const full = renderNekroNxtExtensionDevelopmentSkill()
    for (const topic of topics) expect(full).toContain(topic.text)
    expect(full).toContain('## 强制边界')
    expect(full).toContain(`契约版本：${reference.contractVersion}`)
    expect(referenceFacts().filter((fact) => !full.includes(fact))).toEqual([])
  })

  it('finds a topic by id or title', () => {
    expect(findNekroNxtExtensionReferenceTopic(' tools ')?.id).toBe('tools')
    expect(findNekroNxtExtensionReferenceTopic('配置与凭据')?.id).toBe('config')
    expect(findNekroNxtExtensionReferenceTopic('weather')).toBeUndefined()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- What an untyped caller may pass.
    expect(() => renderNekroNxtExtensionReferenceTopic('weather' as 'tools')).toThrow('weather')
  })
})
