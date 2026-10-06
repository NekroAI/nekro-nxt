import { expect, test, type Page } from '@playwright/test'

/**
 * Motion acceptance (docs/05 动效验收): sample every animation frame of a transition and assert that the canvas
 * never goes blank, labels never fade, indicators slide instead of jumping, and a click answers at once.
 */

interface Probe {
  /** Element clicked to start the transition. */
  readonly target: string
  /** Sliding selection indicator. */
  readonly indicator: string
  /** Labels that must stay fully visible. */
  readonly labels: string
  /** The currently selected label. */
  readonly selected: string
}

interface FrameSample {
  readonly mainText: number
  readonly canvasOpacity: number
  readonly labelOpacity: readonly number[]
  readonly indicator: string
  readonly selected: string
}

/** Clicks `probe.target` and records one sample per animation frame for `durationMs`. */
const sampleFrames = (page: Page, probe: Probe, durationMs: number): Promise<FrameSample[]> =>
  page.evaluate(
    async ({ probe, durationMs }) => {
      const read = () => {
        const indicator = document.querySelector<HTMLElement>(probe.indicator)
        return {
          mainText: document.querySelector('main [data-canvas]')?.textContent?.trim().length ?? 0,
          canvasOpacity: Number(
            getComputedStyle(document.querySelector('main [data-canvas]') ?? document.body).opacity,
          ),
          labelOpacity: [...document.querySelectorAll<HTMLElement>(probe.labels)].map((label) =>
            Number(getComputedStyle(label).opacity),
          ),
          indicator: indicator ? getComputedStyle(indicator).transform : '',
          selected: document.querySelector(probe.selected)?.textContent?.trim() ?? '',
        }
      }
      const element = document.querySelector<HTMLElement>(probe.target)
      if (!element) throw new Error(`missing ${probe.target}`)
      element.click()
      const samples: ReturnType<typeof read>[] = []
      const start = performance.now()
      await new Promise<void>((resolve) => {
        const tick = () => {
          samples.push(read())
          if (performance.now() - start < durationMs) requestAnimationFrame(tick)
          else resolve()
        }
        requestAnimationFrame(tick)
      })
      return samples
    },
    { probe, durationMs },
  )

const settingsNav = (section: string): Probe => ({
  target: `aside[aria-label="设置"] a[href="/settings/${section}"]`,
  indicator: 'aside[aria-label="设置"] span[aria-hidden="true"]',
  labels: 'aside[aria-label="设置"] a',
  selected: 'aside[aria-label="设置"] a[data-selected="true"]',
})

/** The click on 模型 has answered: the selection left 外观 for the section or, once it resolves, its first provider. */
const movedToModels = (frame: FrameSample) => frame.selected !== '' && frame.selected !== '外观'

test.describe('motion audit', () => {
  test('switching spaces never shows a blank canvas', async ({ page }) => {
    await page.goto('/settings/appearance')
    await expect(page.getByRole('heading', { name: '外观' })).toBeVisible()
    // Spaces are prefetched once the first screen is idle (at most 2 s after the first render).
    await page.waitForTimeout(2500)
    for (const space of ['/wiring', '/workshop', '/live']) {
      const frames = await sampleFrames(
        page,
        { target: `a[href="${space}"]`, indicator: 'nav span', labels: 'nav a', selected: 'nav [aria-current]' },
        700,
      )
      expect(frames.length).toBeGreaterThan(10)
      expect(frames.filter((frame) => frame.mainText === 0)).toEqual([])
      expect(Math.min(...frames.map((frame) => frame.canvasOpacity))).toBeGreaterThan(0.4)
    }
  })

  test('a selection list slides its highlight under readable labels and answers within a frame', async ({ page }) => {
    await page.goto('/settings/appearance')
    await expect(page.getByRole('heading', { name: '外观' })).toBeVisible()
    await page.waitForTimeout(400)
    const frames = await sampleFrames(page, settingsNav('models'), 700)

    // Feedback: the new selection shows within three frames (~50 ms; routing commits in a transition).
    expect(frames.slice(0, 3).some(movedToModels)).toBe(true)
    // Text: every label stays fully opaque on every frame.
    expect(frames.flatMap((frame) => frame.labelOpacity).every((opacity) => opacity === 1)).toBe(true)
    // Motion: the highlight passes through intermediate positions instead of jumping.
    expect(new Set(frames.map((frame) => frame.indicator)).size).toBeGreaterThan(3)
  })

  test('reduced motion keeps the same result without the slide', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/settings/appearance')
    await expect(page.getByRole('heading', { name: '外观' })).toBeVisible()
    await page.waitForTimeout(400)
    const frames = await sampleFrames(page, settingsNav('models'), 400)
    expect(frames.slice(0, 3).some(movedToModels)).toBe(true)
    // Without motion the highlight lands in place: it may step from the start to the section and then to the section's
    // first provider once that page resolves, but it never passes through intermediate positions.
    expect(new Set(frames.map((frame) => frame.indicator)).size).toBeLessThanOrEqual(3)
    expect(frames.flatMap((frame) => frame.labelOpacity).every((opacity) => opacity === 1)).toBe(true)
  })
})
