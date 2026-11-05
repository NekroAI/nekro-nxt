import Schema from '@deepseek-ai/schemastery'
import { describe, expect, it } from 'vitest'
import { deletePath, diffDraft, getPath, rehydrateSchema, setPath, validateDraft } from '../src/settings-schema.js'

const wire = (schema: unknown): unknown => JSON.parse(JSON.stringify(schema))

describe('NXT Settings Schema', () => {
  it('decodes the public graph and delegates defaults and validation without changing the draft', () => {
    const schema = rehydrateSchema(
      wire(
        Schema.object({
          title: Schema.string().required(),
          retries: Schema.number().min(0).max(5).default(2),
          options: Schema.dict(Schema.boolean()),
          rows: Schema.array(Schema.object({ label: Schema.string().required() })),
          mode: Schema.union([Schema.const('fast'), Schema.const('slow')]),
        }),
      ),
    )
    const draft = { title: '测试配置', rows: [{ label: '示例' }], mode: 'fast' }
    expect(schema.parse(draft)).toMatchObject({ ...draft, retries: 2 })
    expect(draft).not.toHaveProperty('retries')
    expect(validateDraft(schema, { ...draft, retries: 6 })).toContain('retries')
    expect(validateDraft(schema, { ...draft, rows: [{ label: 3 }] })).toContain('label')
    expect(schema.dict?.['rows']?.inner?.dict?.['label']?.type).toBe('string')
    expect(schema.dict?.['mode']?.list?.map((node) => node.value)).toEqual(['fast', 'slow'])
  })

  it('keeps redacted secrets absent and preserves credential references as plain values', () => {
    const schema = rehydrateSchema(
      wire(
        Schema.object({
          token: Schema.string().role('secret').required(),
          credential: Schema.string().role('credential-ref'),
        }),
      ),
    )
    expect(validateDraft(schema, { credential: 'SYNTHETIC_KEY' })).toBeUndefined()
    expect(schema.parse({ credential: 'SYNTHETIC_KEY' })).not.toHaveProperty('token')
    expect(schema.dict?.['credential']?.meta.role).toBe('credential-ref')
  })

  it('names the field and the problem in a validation message', () => {
    const schema = rehydrateSchema(
      wire(
        Schema.object({
          providers: Schema.dict(
            Schema.object({
              apiKeyEnv: Schema.string().role('credential-ref'),
              models: Schema.array(
                Schema.object({ id: Schema.string().required(), contextWindow: Schema.number().step(1).min(1) }),
              ),
            }),
          ),
        }),
      ),
    )
    const models = (entry: Record<string, unknown>) => ({ providers: { example: { models: [{ id: 'm1' }, entry] } } })
    expect(validateDraft(schema, models({ id: 'm2', contextWindow: 1.5 }))).toBe(
      'providers.example.models[1].contextWindow：需要是整数',
    )
    expect(validateDraft(schema, models({ id: 'm2', contextWindow: 0 }))).toBe(
      'providers.example.models[1].contextWindow：不能小于 1',
    )
    expect(validateDraft(schema, models({ contextWindow: 8 }))).toBe('providers.example.models[1].id：需要填写')
    expect(validateDraft(schema, models({ id: 'm2', contextWindow: '大' }))).toBe(
      'providers.example.models[1].contextWindow：需要是数字',
    )
    expect(validateDraft(schema, { providers: { example: { apiKeyEnv: 'SYNTHETIC_KEY' } } })).toBeUndefined()
    expect(validateDraft(schema, { providers: { example: { apiKeyEnv: 'sk-synthetic value' } } })).toBe(
      'providers.example.apiKeyEnv：需要是凭据名称，只能包含字母、数字和下划线',
    )
  })

  it('turns a whole edited value into field edits', () => {
    const before = { title: '旧标题', nested: { keep: 1, drop: 2 }, rows: [{ id: 'a' }] }
    const after = { title: '旧标题', nested: { keep: 1, added: true }, rows: [{ id: 'a' }, { id: 'b' }] }
    expect(diffDraft(before, after)).toEqual([
      { op: 'unset', path: ['nested', 'drop'] },
      { op: 'set', path: ['nested', 'added'], value: true },
      { op: 'set', path: ['rows'], value: [{ id: 'a' }, { id: 'b' }] },
    ])
    expect(diffDraft(before, structuredClone(before))).toEqual([])
    expect(diffDraft({ title: 'x' }, ['x'])).toEqual([{ op: 'set', path: [], value: ['x'] }])
  })

  it('never evaluates callbacks from a serialized custom Schema', () => {
    const schema = rehydrateSchema({
      uid: 1,
      refs: {
        1: { type: 'transform', inner: 2, callback: '(() => { throw new Error("must not run") })()' },
        2: { type: 'string', meta: { description: { zh: '示例字段' }, link: 'javascript:alert(1)' } },
      },
    })
    expect(schema.type).toBe('transform')
    expect(schema.parse('示例')).toBe('示例')
    expect(schema.inner?.meta.description).toEqual({ zh: '示例字段' })
    expect(schema.inner?.meta.link).toBeUndefined()
  })

  it('rejects missing references, recursive graphs and malformed containers', () => {
    expect(() => rehydrateSchema({ uid: 1, refs: { 1: { type: 'object', dict: { field: 2 } } } })).toThrow()
    expect(() => rehydrateSchema({ uid: 1, refs: { 1: { type: 'array', inner: 1 } } })).toThrow('递归')
    expect(() => rehydrateSchema({ type: 'array' })).toThrow('元素定义')
    expect(() => rehydrateSchema({ type: 'union', list: 'bad' })).toThrow('列表')
  })

  it('updates nested object and collection drafts without mutating authority', () => {
    const authority = { nested: { enabled: true }, rows: [{ value: 1 }, { value: 2 }] }
    const updated = setPath(authority, ['rows', '0', 'value'], 3)
    expect(getPath(updated, ['rows', '0', 'value'])).toBe(3)
    expect(getPath(authority, ['rows', '0', 'value'])).toBe(1)
    expect(deletePath(updated, ['rows', '0'])).toEqual({ nested: { enabled: true }, rows: [{ value: 2 }] })
    expect(deletePath(authority, ['nested', 'enabled'])).toEqual({ nested: {}, rows: authority.rows })
    expect(setPath(undefined, ['nested', 'enabled'], false)).toEqual({ nested: { enabled: false } })
  })

  it('rejects prototype paths and invalid array indices', () => {
    expect(() => setPath({}, ['__proto__', 'polluted'], true)).toThrow('配置路径')
    expect(() => getPath({}, ['constructor'])).toThrow('配置路径')
    expect(() => deletePath({}, ['prototype'])).toThrow('配置路径')
    expect(() => setPath([], ['-1'], true)).toThrow('下标')
    expect(() => setPath([], ['999999'], true)).toThrow('下标')
    expect(getPath({}, ['toString'])).toBeUndefined()
  })
})
