import type { ModelFallbackReason, ModelFallbackSettings } from '@nekro-nxt/contracts'
import type { AgentModelSelection } from '@nekro-nxt/core'

interface FailureFacts {
  readonly code: string
  readonly message: string
}

/**
 * What relays put in the body of a 400 that only passes on an upstream failure. one-api / one-hub wrap any upstream
 * error as `upstream_error` / `bad_response_status_code`; new-api says its account pool or channels have nothing free
 * right now. The request itself was fine, so these count as an unavailable model, not a bad request.
 */
const RELAY_UNAVAILABLE_PATTERNS = [
  /"type"\s*:\s*"upstream_error"/,
  /bad_response_status_code/,
  /pool_channel_unavailable/,
  /no available channel/i,
  /请稍后(?:再|重)?试/,
  /try again later/i,
]

/** A 400 from a relay whose upstream was unavailable at the moment, see {@link RELAY_UNAVAILABLE_PATTERNS}. */
export const isRelayUnavailable = (failure: FailureFacts): boolean =>
  failure.code === 'INVALID_REQUEST' && RELAY_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(failure.message))

/**
 * How a failed model request counts toward switching models. `quota` switches at once; `unavailable` and
 * `rate-limit` switch only after the usual retries gave up; anything else (credentials, context window, arguments)
 * is a problem a fallback model would hide, so it never switches.
 */
export const fallbackReasonOf = (failure: FailureFacts): ModelFallbackReason | undefined => {
  const { code } = failure
  if (code === 'QUOTA' || code === 'ACCOUNT_QUOTA') return 'quota'
  if (code === 'RATE_LIMIT') return 'rate-limit'
  if (code === 'SERVER' || code === 'TIMEOUT' || code === 'TRANSPORT' || code === 'EMPTY_RESPONSE') return 'unavailable'
  if (isRelayUnavailable(failure)) return 'unavailable'
  return undefined
}

/**
 * How often a step that failed with a 400 is tried again. DSH never retries a 400, but relays also use it for an
 * upstream that was briefly unavailable: those get the retries DSH gives a server error; any other 400 is tried once
 * more, since a relay may say the same in words not listed above.
 */
export const badRequestRetries = (failure: FailureFacts): number =>
  failure.code !== 'INVALID_REQUEST' ? 0 : isRelayUnavailable(failure) ? 5 : 1

/** The wait before retry `attempt` (from 0): DSH's backoff for server errors, 0.5 s doubling up to 10 s, ±10 %. */
export const badRequestRetryDelayMs = (attempt: number): number =>
  Math.round(Math.min(500 * 2 ** attempt, 10_000) * (0.9 + Math.random() * 0.2))

export const sameRoute = (left: AgentModelSelection, right: AgentModelSelection): boolean =>
  left.provider === right.provider && left.model === right.model

const routeKey = (route: AgentModelSelection) => `${route.provider}\0${route.model}`

/** When a failed route may be tried again, by why it failed. */
export const cooldownMs = (reason: ModelFallbackReason, settings: ModelFallbackSettings): number =>
  (reason === 'quota' ? settings.quotaCooldownMinutes : settings.unavailableCooldownMinutes) * 60_000

/**
 * Model routes that failed recently, shared by every conversation of the host so one that ran out of quota is passed
 * over everywhere instead of failing once in each channel first. Kept in memory: after a restart every route is tried
 * again.
 */
export class ModelRouteHealth {
  readonly #cooling = new Map<string, { readonly until: number; readonly reason: ModelFallbackReason }>()

  markFailed(route: AgentModelSelection, reason: ModelFallbackReason, until: number): void {
    this.#cooling.set(routeKey(route), { until, reason })
  }

  /** Until when the route is passed over, while it is. */
  coolingUntil(route: AgentModelSelection, now: number): number | undefined {
    const entry = this.#cooling.get(routeKey(route))
    if (entry === undefined) return undefined
    if (entry.until > now) return entry.until
    this.#cooling.delete(routeKey(route))
    return undefined
  }
}

/** The first route of `chain` (the main model, then its fallbacks) that is not cooling down and not excluded. */
export const firstHealthyRoute = (
  chain: readonly AgentModelSelection[],
  health: ModelRouteHealth,
  now: number,
  exclude?: AgentModelSelection,
): AgentModelSelection | undefined =>
  chain.find(
    (route) => (exclude === undefined || !sameRoute(route, exclude)) && health.coolingUntil(route, now) === undefined,
  )

/**
 * Which route one request of a conversation uses. A conversation stays on the route it is on; it leaves a route that
 * started cooling down, and goes back to the main model only when a new message starts a turn, so a turn never
 * switches back in the middle and the cache is rebuilt at most once per switch.
 */
export const routeForRequest = (input: {
  readonly chain: readonly AgentModelSelection[]
  readonly current: AgentModelSelection
  readonly startsTurn: boolean
  readonly health: ModelRouteHealth
  readonly now: number
}): AgentModelSelection => {
  const main = input.chain[0]
  if (main === undefined) return input.current
  if (input.startsTurn && !sameRoute(input.current, main) && input.health.coolingUntil(main, input.now) === undefined) {
    return main
  }
  if (input.health.coolingUntil(input.current, input.now) === undefined) return input.current
  // Every route cooling down: keep trying the current one rather than stop answering.
  return firstHealthyRoute(input.chain, input.health, input.now) ?? input.current
}
