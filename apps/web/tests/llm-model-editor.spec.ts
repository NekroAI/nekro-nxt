import { describe, expect, it } from 'vitest'
import { emptyModelRow, modelPayload, modelRowFromModel, modelRowsError, modelsToAdd } from '../src/llm-model-editor.js'

describe('model list editor', () => {
  it('round-trips a vision model and states text-only models explicitly', () => {
    const vision = modelRowFromModel({
      id: 'synthetic-flash',
      name: 'Synthetic Flash',
      contextWindow: 1_000_000,
      inputModalities: ['text', 'image'],
    })
    const text = modelRowFromModel({ id: 'synthetic-pro', name: 'synthetic-pro' })
    expect(vision).toMatchObject({ name: 'Synthetic Flash', contextWindow: '1000000', image: true })
    expect(text).toMatchObject({ name: '', image: false })
    expect(modelPayload([vision, text])).toEqual([
      { id: 'synthetic-flash', name: 'Synthetic Flash', contextWindow: 1_000_000, inputModalities: ['text', 'image'] },
      { id: 'synthetic-pro', inputModalities: ['text'] },
    ])
  })

  it('explains invalid rows before saving', () => {
    expect(modelRowsError([])).toBe('请至少添加一个模型。')
    expect(modelRowsError([emptyModelRow()])).toBe('模型 ID 不能为空。')
    const row = modelRowFromModel({ id: 'same' })
    expect(modelRowsError([row, { ...row, key: 'other' }])).toBe('模型 ID same 重复。')
    expect(modelRowsError([{ ...row, contextWindow: '12.5' }])).toContain('正整数')
    expect(modelRowsError([row])).toBeUndefined()
  })

  it('offers only discovered models that are not already listed', () => {
    const rows = [modelRowFromModel({ id: 'listed' })]
    expect(modelsToAdd(rows, [{ id: 'listed' }, { id: 'new-model', inputModalities: ['text', 'image'] }])).toEqual([
      { id: 'new-model', inputModalities: ['text', 'image'] },
    ])
  })
})
