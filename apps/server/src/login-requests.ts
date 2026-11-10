import { createHash, randomBytes, randomInt } from 'node:crypto'
import type { ManagementDeviceId } from '@nekro-nxt/contracts'

/** Letters and digits that are hard to confuse when typed from a screen. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const LOGIN_CODE_TTL_MS = 5 * 60 * 1_000
/** Per kind, so codes asked for by browsers that are not signed in cannot use up the invites of signed-in devices. */
const MAX_PENDING_PER_KIND = 100

type State = 'open' | 'waiting' | 'approved' | 'rejected'

interface LoginRequest {
  readonly code: string
  /**
   * `invite`: a signed-in device shows the code and a new device scans it.
   * `request`: the new device shows the code and a signed-in device scans it.
   */
  readonly kind: 'invite' | 'request'
  readonly expiresAt: number
  state: State
  requesterLabel?: string
  /** Digest of the secret the new device polls with; set once a new device holds the code. */
  secretDigest?: string
  approvedBy?: ManagementDeviceId
}

export type LoginRequestView = Pick<LoginRequest, 'code' | 'kind' | 'state' | 'requesterLabel' | 'expiresAt'>

const digest = (secret: string): string => createHash('sha256').update('nxt-login-request').update(secret).digest('hex')

/** `ABCD-EFGH`; typed codes may omit the dash and use lower case. */
export const normalizeLoginCode = (input: string): string | undefined => {
  const compact = input.toUpperCase().replace(/[^A-Z0-9]/gu, '')
  if (compact.length !== 8 || [...compact].some((char) => !CODE_ALPHABET.includes(char))) return undefined
  return `${compact.slice(0, 4)}-${compact.slice(4)}`
}

/**
 * One-time sign-in codes for scanning between devices. Every sign-in ends with a signed-in device approving it; the
 * new device then picks up its session with a secret only it holds. Codes live five minutes and work once.
 */
export class LoginRequests {
  readonly #requests = new Map<string, LoginRequest>()
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  /** A signed-in device shows this code for a new device to scan. */
  createInvite(): LoginRequestView {
    return this.#view(this.#create('invite'))
  }

  /** A new device shows this code for a signed-in device to scan; it polls with the returned secret. */
  createRequest(requesterLabel: string): LoginRequestView & { readonly secret: string } {
    const request = this.#create('request')
    const secret = randomBytes(32).toString('base64url')
    request.state = 'waiting'
    request.requesterLabel = requesterLabel
    request.secretDigest = digest(secret)
    return { ...this.#view(request), secret }
  }

  /** A new device scanned an invite; the code now waits for the signed-in device to approve it. */
  claim(input: string, requesterLabel: string): (LoginRequestView & { readonly secret: string }) | undefined {
    const request = this.#find(input)
    if (request === undefined || request.kind !== 'invite' || request.state !== 'open') return undefined
    const secret = randomBytes(32).toString('base64url')
    request.state = 'waiting'
    request.requesterLabel = requesterLabel
    request.secretDigest = digest(secret)
    return { ...this.#view(request), secret }
  }

  get(input: string): LoginRequestView | undefined {
    const request = this.#find(input)
    return request === undefined ? undefined : this.#view(request)
  }

  /** Only a code a new device is waiting on can be decided. */
  decide(input: string, approve: boolean, deviceId: ManagementDeviceId): LoginRequestView | undefined {
    const request = this.#find(input)
    if (request === undefined || request.state !== 'waiting') return undefined
    request.state = approve ? 'approved' : 'rejected'
    if (approve) request.approvedBy = deviceId
    return this.#view(request)
  }

  /**
   * What the new device learns when it polls. `approved` is returned once; the code is gone afterwards, so the session
   * it leads to cannot be picked up twice.
   */
  poll(secret: string): 'waiting' | 'approved' | 'rejected' | 'expired' {
    this.#clean()
    const wanted = digest(secret)
    for (const [code, request] of this.#requests) {
      if (request.secretDigest !== wanted) continue
      if (request.state === 'waiting') return 'waiting'
      this.#requests.delete(code)
      return request.state === 'approved' ? 'approved' : 'rejected'
    }
    return 'expired'
  }

  #create(kind: LoginRequest['kind']): LoginRequest {
    this.#clean()
    let pending = 0
    for (const request of this.#requests.values()) if (request.kind === kind) pending += 1
    if (pending >= MAX_PENDING_PER_KIND) throw new Error('待确认的登录太多，请稍后再试。')
    let code: string
    do {
      code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('')
      code = `${code.slice(0, 4)}-${code.slice(4)}`
    } while (this.#requests.has(code))
    const request: LoginRequest = { code, kind, state: 'open', expiresAt: this.#now() + LOGIN_CODE_TTL_MS }
    this.#requests.set(code, request)
    return request
  }

  #find(input: string): LoginRequest | undefined {
    this.#clean()
    const code = normalizeLoginCode(input)
    return code === undefined ? undefined : this.#requests.get(code)
  }

  #clean(): void {
    const now = this.#now()
    for (const [code, request] of this.#requests) if (request.expiresAt <= now) this.#requests.delete(code)
  }

  #view(request: LoginRequest): LoginRequestView {
    return {
      code: request.code,
      kind: request.kind,
      state: request.state,
      ...(request.requesterLabel === undefined ? {} : { requesterLabel: request.requesterLabel }),
      expiresAt: request.expiresAt,
    }
  }
}
