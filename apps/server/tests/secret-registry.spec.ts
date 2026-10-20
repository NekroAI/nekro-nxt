import { describe, expect, it } from 'vitest'
import { HIDDEN_SECRET_TEXT, SecretRegistry } from '../src/secret-registry.ts'

const SECRET = 'fictional-secret-0123456789abcdef'

describe('SecretRegistry', () => {
  it('hides the raw value and its base64 and URL-encoded forms', () => {
    const secrets = new SecretRegistry()
    secrets.register('fictional/pass word+key=1')
    secrets.register(SECRET)
    const base64 = Buffer.from(SECRET).toString('base64')
    const base64Url = Buffer.from('fictional/pass word+key=1').toString('base64url')
    const text = [
      `raw ${SECRET}`,
      `std ${base64}`,
      `bare ${base64.replace(/=+$/u, '')}`,
      `url-safe ${base64Url}`,
      `query ?token=${encodeURIComponent('fictional/pass word+key=1')}`,
    ].join('\n')

    const redacted = secrets.redact(text)

    expect(redacted).not.toContain(SECRET)
    expect(redacted).not.toContain(base64.replace(/=+$/u, ''))
    expect(redacted).not.toContain(base64Url)
    expect(redacted).not.toContain('fictional%2Fpass')
    expect(redacted.match(/\[凭据已隐藏\]/gu)).toHaveLength(5)
    expect(secrets.contains(`Bearer ${base64}`)).toBe(true)
  })

  it('keeps values under 8 characters for logs only', () => {
    const secrets = new SecretRegistry()
    secrets.register('abc')
    secrets.register('pin1234')

    expect(secrets.logValues()).toEqual(['pin1234'])
    expect(secrets.redact('pin1234 abc')).toBe('pin1234 abc')
    expect(secrets.contains('pin1234')).toBe(false)
  })

  it('names the credential in the replacement when it has a label', () => {
    const secrets = new SecretRegistry()
    secrets.register(SECRET)
    secrets.register(SECRET, { label: '演示模型' })

    expect(secrets.redact(`key=${SECRET}`)).toBe('key=[凭据:演示模型]')
  })

  it('redacts strings deep inside JSON and returns unchanged values as they are', () => {
    const secrets = new SecretRegistry()
    secrets.register(SECRET)
    const clean = { items: [{ text: 'nothing here' }] }
    const value = { stdout: `export KEY=${SECRET}`, nested: [{ [SECRET]: [SECRET, 1, null, true] }] }

    expect(secrets.redactValue(clean)).toBe(clean)
    expect(secrets.redactValue(value)).toEqual({
      stdout: `export KEY=${HIDDEN_SECRET_TEXT}`,
      nested: [{ [HIDDEN_SECRET_TEXT]: [HIDDEN_SECRET_TEXT, 1, null, true] }],
    })
    expect(secrets.containsValue(value)).toBe(true)
    expect(secrets.containsValue({ [SECRET]: 1 })).toBe(true)
    expect(secrets.containsValue(clean)).toBe(false)
  })
})
