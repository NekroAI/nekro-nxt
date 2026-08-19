import { describe, expect, it } from 'vitest'
import { orderByIds } from '../src/shell/work-tree-order.js'

describe('orderByIds', () => {
  it('applies preferred ids then appends newcomers', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(orderByIds(items, ['c', 'missing', 'a']).map((item) => item.id)).toEqual(['c', 'a', 'b'])
  })
})
