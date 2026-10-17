import type { Route } from '@playwright/test'

/**
 * Errors from a request the page gave up on before it was answered: a newer load replaced it, the page navigated (the
 * forwarded fetch is then reset), or the test ended.
 */
const abandoned = (error: unknown): boolean =>
  error instanceof Error &&
  /Response has been disposed|Target page, context or browser has been closed|Test ended|ECONNRESET/u.test(
    error.message,
  )

/**
 * Wraps a handler that rewrites the real response. A request the page has already abandoned needs no answer, so only
 * those errors are ignored; anything else still fails the test.
 */
export const answering =
  (handler: (route: Route) => Promise<void>) =>
  async (route: Route): Promise<void> => {
    try {
      await handler(route)
    } catch (error) {
      if (!abandoned(error)) throw error
    }
  }
