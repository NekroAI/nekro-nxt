/** Hidden-value marker shown wherever a registered secret would have appeared. */
export const HIDDEN_SECRET_TEXT = '[凭据已隐藏]'

/** Log redaction keeps its historical floor; shorter values would mangle ordinary words. */
const LOG_MIN_LENGTH = 4
/**
 * Context redaction and argument denial start at 8 characters. Shorter values (PINs, short passwords) collide with
 * ordinary text and would deny unrelated tool calls; they are still hidden in logs.
 */
export const CONTEXT_MIN_LENGTH = 8
const MAX_LENGTH = 16_384
const MAX_VALUES = 2048
const MAX_LABEL_LENGTH = 32

interface Matcher {
  readonly pattern: RegExp
  /** Every encoded form maps to the replacement of the value it encodes. */
  readonly replacements: ReadonlyMap<string, string>
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/** The raw value plus the encodings a tool or program commonly prints it in. */
const encodedForms = (value: string): string[] => {
  const base64 = Buffer.from(value, 'utf8').toString('base64')
  const base64Url = Buffer.from(value, 'utf8').toString('base64url')
  const forms = new Set([
    value,
    base64,
    base64.replace(/=+$/u, ''),
    base64Url,
    `${base64Url}${'='.repeat((4 - (base64Url.length % 4)) % 4)}`,
  ])
  try {
    forms.add(encodeURIComponent(value))
  } catch {
    /* A lone surrogate has no URI encoding; the other forms still apply. */
  }
  return [...forms]
}

/**
 * The host's one set of known secret values. Credential stores register values as they are saved, resolved or
 * preloaded; logs and everything that reaches the model (tool results, inbound messages, extension context) read it.
 * Matching is literal: the raw value, its standard and URL-safe base64 (with and without padding) and its
 * `encodeURIComponent` form. A value embedded inside a longer base64 stream is not recognised.
 */
export class SecretRegistry {
  readonly #labels = new Map<string, string | undefined>()
  #matcher: Matcher | null | undefined

  /** `label` names the credential in the replacement (`[凭据:label]`); without one the generic marker is used. */
  register(value: string, options: { readonly label?: string } = {}): void {
    if (value.length < LOG_MIN_LENGTH || value.length > MAX_LENGTH) return
    const label = options.label?.trim().slice(0, MAX_LABEL_LENGTH) || undefined
    if (this.#labels.has(value) && (label === undefined || this.#labels.get(value) === label)) return
    if (!this.#labels.has(value) && this.#labels.size >= MAX_VALUES) {
      this.#labels.delete(this.#labels.keys().next().value!)
    }
    this.#labels.set(value, label ?? this.#labels.get(value))
    this.#matcher = undefined
  }

  /** Raw values for log redaction, including the short ones context redaction ignores. */
  logValues(): string[] {
    return [...this.#labels.keys()]
  }

  redact(text: string): string {
    const matcher = this.#current()
    if (matcher === null) return text
    matcher.pattern.lastIndex = 0
    return text.replace(matcher.pattern, (found) => matcher.replacements.get(found) ?? HIDDEN_SECRET_TEXT)
  }

  contains(text: string): boolean {
    const matcher = this.#current()
    if (matcher === null) return false
    matcher.pattern.lastIndex = 0
    return matcher.pattern.test(text)
  }

  /**
   * Deep copy with every string (and object key) redacted; returns the same reference when nothing matched. Only
   * plain objects and arrays are copied, and only string leaves change, so the shape the caller passed in holds.
   */
  redactValue<Value>(value: Value): Value {
    if (this.#current() === null) return value
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Structure-preserving: see above.
    return this.#redactDeep(value, new WeakSet()) as Value
  }

  containsValue(value: unknown): boolean {
    if (this.#current() === null) return false
    const stack: unknown[] = [value]
    const seen = new WeakSet<object>()
    while (stack.length > 0) {
      const item = stack.pop()
      if (typeof item === 'string') {
        if (this.contains(item)) return true
      } else if (item !== null && typeof item === 'object' && !seen.has(item)) {
        seen.add(item)
        if (Array.isArray(item)) for (const entry of item as unknown[]) stack.push(entry)
        else
          for (const [key, entry] of Object.entries(item)) {
            if (this.contains(key)) return true
            stack.push(entry)
          }
      }
    }
    return false
  }

  #redactDeep(value: unknown, seen: WeakSet<object>): unknown {
    if (typeof value === 'string') return this.redact(value)
    if (value === null || typeof value !== 'object' || seen.has(value)) return value
    seen.add(value)
    if (Array.isArray(value)) {
      let changed = false
      const items = value.map((item: unknown) => {
        const redacted = this.#redactDeep(item, seen)
        if (redacted !== item) changed = true
        return redacted
      })
      return changed ? items : value
    }
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return value
    let changed = false
    const entries = Object.entries(value).map(([key, item]: [string, unknown]) => {
      const redactedKey = this.redact(key)
      const redacted = this.#redactDeep(item, seen)
      if (redactedKey !== key || redacted !== item) changed = true
      return [redactedKey, redacted] as const
    })
    return changed ? Object.fromEntries(entries) : value
  }

  #current(): Matcher | null {
    if (this.#matcher !== undefined) return this.#matcher
    const replacements = new Map<string, string>()
    for (const [value, label] of this.#labels) {
      if (value.length < CONTEXT_MIN_LENGTH) continue
      const replacement = label === undefined ? HIDDEN_SECRET_TEXT : `[凭据:${label}]`
      for (const form of encodedForms(value)) if (!replacements.has(form)) replacements.set(form, replacement)
    }
    // Longest first, so a padded base64 form wins over its unpadded prefix.
    const forms = [...replacements.keys()].sort((left, right) => right.length - left.length)
    this.#matcher =
      forms.length === 0 ? null : { pattern: new RegExp(forms.map(escapeRegExp).join('|'), 'gu'), replacements }
    return this.#matcher
  }
}
