import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CandidateVerifier, type VerifierBrowser, type WaitingCandidate } from '../src/candidate-verifier.js'
import { VerificationBrowser } from '../src/verification-browser.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const scratch = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-verifier-'))
  temporaryDirectories.push(directory)
  return directory
}

/** A browser whose pages only record where they were sent. */
const fakeBrowser = () => {
  const visited: string[] = []
  let closed = false
  const browser: VerifierBrowser = {
    newPage: () =>
      Promise.resolve({
        goto: (url: string) => {
          visited.push(url)
          return Promise.resolve(null)
        },
        waitForTimeout: () => Promise.resolve(),
        close: () => Promise.resolve(),
      }),
    close: () => {
      closed = true
      return Promise.resolve()
    },
  }
  return { browser, visited, closed: () => closed }
}

describe('verification browser', () => {
  it('reports installer progress, finds the installed browser and offers removal', async () => {
    const root = path.join(await scratch(), 'chromium')
    const states: string[] = []
    const browser = new VerificationBrowser({
      root,
      install: async (target, onLine) => {
        onLine('|■■■■■■■■         |  40% of 90.0 MiB')
        const folder = path.join(target, 'chromium_headless_shell-1', 'chrome-headless-shell-linux64')
        await mkdir(folder, { recursive: true })
        await writeFile(path.join(folder, 'chrome-headless-shell'), '')
        return 0
      },
    })
    browser.subscribe(() => states.push(browser.status().download?.state ?? 'ready'))
    await browser.prepare()
    expect(browser.status()).toMatchObject({ available: false, download: { state: 'idle' } })
    browser.startDownload()
    await expect.poll(() => browser.status().available).toBe(true)
    expect(states).toContain('downloading')
    expect(browser.status()).toEqual({ available: true, source: 'downloaded', version: 'Chromium' })
    await browser.removeDownloaded()
    expect(browser.status().available).toBe(false)
  })

  it('shows why an installed browser cannot start and keeps candidates from trying again', async () => {
    const root = path.join(await scratch(), 'chromium')
    await mkdir(path.join(root, 'chromium_headless_shell-1', 'chrome-headless-shell-linux64'), { recursive: true })
    await writeFile(
      path.join(root, 'chromium_headless_shell-1', 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
      '',
    )
    let attempts = 0
    const browser = new VerificationBrowser({
      root,
      launch: () => {
        attempts += 1
        return Promise.reject(new Error('缺少系统库 libnss3\n更多细节'))
      },
    })
    await browser.prepare()
    expect(await browser.launch()).toBeUndefined()
    expect(await browser.launch()).toBeUndefined()
    expect(attempts).toBe(1)
    expect(browser.status()).toMatchObject({
      available: false,
      download: { state: 'failed', error: '无法启动：缺少系统库 libnss3' },
    })
  })
})

describe('candidate verifier', () => {
  const setup = (input: { readonly withBrowser: boolean; readonly now: () => number }) => {
    const waiting: WaitingCandidate[] = [{ taskId: 'aut_WAITING', updatedAt: 0 }]
    const settled = new Set<string>()
    const ranWithoutClient: string[] = []
    const fake = fakeBrowser()
    const verifier = new CandidateVerifier({
      waiting: () => waiting.filter((item) => !settled.has(item.taskId)),
      settled: (taskId) => settled.has(taskId),
      origin: () => 'http://127.0.0.1:4960',
      browser: { launch: () => Promise.resolve(input.withBrowser ? fake.browser : undefined) },
      runWithoutClient: (taskId) => {
        ranWithoutClient.push(taskId)
        settled.add(taskId)
        return Promise.resolve()
      },
      now: input.now,
      graceMs: 8_000,
      visitMs: 0,
    })
    return { verifier, settled, ranWithoutClient, fake }
  }

  it('leaves a candidate to an open page during the grace period, then opens its task page headless', async () => {
    let clock = 5_000
    const { verifier, ranWithoutClient, fake } = setup({ withBrowser: true, now: () => clock })
    await verifier.tick()
    expect(fake.visited).toEqual([])
    clock = 9_000
    await verifier.tick()
    expect(fake.visited).toEqual(['http://127.0.0.1:4960/workshop/tasks/aut_WAITING'])
    expect(ranWithoutClient).toEqual([])
    // The same waiting state is taken once.
    await verifier.tick()
    expect(fake.visited).toHaveLength(1)
    await verifier.dispose()
    expect(fake.closed()).toBe(true)
  })

  it('runs the candidate with its interface unchecked when no browser is available', async () => {
    const { verifier, ranWithoutClient } = setup({ withBrowser: false, now: () => 60_000 })
    await verifier.tick()
    expect(ranWithoutClient).toEqual(['aut_WAITING'])
    await verifier.dispose()
  })
})
