import { describe, expect, it } from 'vitest'
import { redactAdapterDiagnosticText } from '../src/diagnostics.js'

describe('protocol error diagnostics', () => {
  it.each([
    ['Authorization: Bearer fictional-bearer', 'fictional-bearer'],
    ['{"access_token":"fictional-token"}', 'fictional-token'],
    ['password=fictional-password refused', 'fictional-password'],
    ['GET https://example.test/private?token=fictional-link failed', 'example.test'],
    ['file /data/fictional/private/fixture.txt failed', '/data/fictional'],
    ['file C:\\synthetic\\private.txt failed', 'C:\\synthetic'],
  ])('redacts sensitive values from %s', (input, hidden) => {
    expect(redactAdapterDiagnosticText(input)).not.toContain(hidden)
  })
  it('removes exact known credentials even when the platform echoes an unlabelled value', () => {
    expect(redactAdapterDiagnosticText('Rejected fictional-opaque; permission denied', ['fictional-opaque'])).toBe(
      'Rejected [已隐藏]; permission denied',
    )
    expect(redactAdapterDiagnosticText('权限不足，请检查频道权限。')).toBe('权限不足，请检查频道权限。')
  })
})
