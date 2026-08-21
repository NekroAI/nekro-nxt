import { describe, expect, it } from 'vitest'
import { isDshSettingsSchemaWireSafe } from '../src/index.js'

const envelope = (root: Record<string, unknown>, extra: Record<number, Record<string, unknown>> = {}) => ({
  uid: 1,
  refs: { 1: root, ...extra },
})

describe('DSH Settings wire safety', () => {
  it('accepts Secrets reached through containers supported by 0.1.1-rc.1 redaction', () => {
    expect(
      isDshSettingsSchemaWireSafe(
        envelope(
          { type: 'object', dict: { token: 2, rows: 3 } },
          {
            2: { type: 'string', meta: { role: 'secret' } },
            3: { type: 'array', inner: 2 },
          },
        ),
      ),
    ).toBe(true)
  })

  it.each(['union', 'intersect', 'transform', 'lazy'])('rejects a Secret hidden behind %s', (type) => {
    expect(
      isDshSettingsSchemaWireSafe(
        envelope(type === 'transform' || type === 'lazy' ? { type, inner: 2 } : { type, list: [2] }, {
          2: { type: 'string', meta: { role: 'secret' } },
        }),
      ),
    ).toBe(false)
  })

  it('rejects serialized Secret defaults even on a directly redacted field', () => {
    expect(
      isDshSettingsSchemaWireSafe(
        envelope(
          { type: 'object', dict: { token: 2 } },
          { 2: { type: 'string', meta: { role: 'secret', default: 'must-not-cross-the-wire' } } },
        ),
      ),
    ).toBe(false)
  })
})
