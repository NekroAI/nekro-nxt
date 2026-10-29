import { createServer } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readRememberedPort, rememberPort, reserveLoopbackPort } from '../src/local-port.ts'

const HOST = '127.0.0.1'
let directory: string | undefined

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

describe('local Host port', () => {
  it('takes the remembered port again so the page keeps its origin', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'nxt-port-'))
    const file = path.join(directory, 'local-host-port.json')
    expect(await readRememberedPort(file)).toBeUndefined()
    const first = await reserveLoopbackPort(HOST, await readRememberedPort(file))
    await rememberPort(file, first)
    expect(await reserveLoopbackPort(HOST, await readRememberedPort(file))).toBe(first)
  })

  it('falls back to any free port when the remembered one is taken', async () => {
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen({ host: HOST, port: 0 }, resolve))
    const address = blocker.address()
    if (address === null || typeof address === 'string') throw new Error('No fixture port.')
    try {
      const port = await reserveLoopbackPort(HOST, address.port)
      expect(port).not.toBe(address.port)
      expect(port).toBeGreaterThan(0)
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  it('ignores an unreadable record', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'nxt-port-'))
    const file = path.join(directory, 'local-host-port.json')
    await writeFile(file, '{"port":"x"}')
    expect(await readRememberedPort(file)).toBeUndefined()
  })
})
