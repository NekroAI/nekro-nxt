import type { ModelFallbackReason, ModelFallbackSettings } from '@nekro-nxt/contracts'
import type { AgentModelSelection } from '@nekro-nxt/core'

/**
 * How a failed model request counts toward switching models. `quota` switches at once; `unavailable` and
 * `rate-limit` switch only after the usual retries gave up; anything else (credentials, context window, arguments)
 * is a problem a fallback model would hide, so it never switches.
 */
export const fallbackReasonOf = (code: string): ModelFallbackReason | undefined => {
  if (code === 'QUOTA' || code === 'ACCOUNT_QUOTA') return 'quota'
  if (code === 'RATE_LIMIT') return 'rate-limit'
  if (code === 'SERVER' || code === 'TIMEOUT' || code === 'TRANSPORT' || code === 'EMPTY_RESPONSE') return 'unavailable'
  return undefined
}

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
