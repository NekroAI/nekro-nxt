import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { createServer, request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import type * as FsPromises from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Reading the source file is the first step of every compression, so counting reads counts compressions.
const reads = vi.hoisted(() => ({ files: [] as string[] }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof FsPromises>()
  return {
    ...original,
    readFile: (file: string) => {
      reads.files.push(file)
      return original.readFile(file)
    },
  }
})

const { createWebAssetHandler } = await import('../src/web-assets.js')

interface Reply {
  readonly status: number
  readonly headers: Record<string, string | string[] | undefined>
  readonly body: Buffer
}

const bigScript = `export const value = ${JSON.stringify('nekro '.repeat(800))}\n`
const bigScriptV2 = `export const value = ${JSON.stringify('nxt '.repeat(900))}\n`

describe('web asset delivery', () => {
  let root: string
  let dist: string
  let server: Server
  let port: number
  let declined: string[]

  const get = (target: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: target, method, headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
      })
      req.on('error', reject)
      req.end()
    })

  beforeEach(async () => {
    reads.files.length = 0
    root = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-web-assets-'))
    dist = path.join(root, 'dist')
    await mkdir(path.join(dist, 'assets'), { recursive: true })
    await mkdir(path.join(dist, 'brand'), { recursive: true })
    await writeFile(path.join(dist, 'index.html'), '<!doctype html><title>fixture</title>')
    await writeFile(path.join(dist, 'assets', 'index-abc123.js'), bigScript)
    await writeFile(path.join(dist, 'assets', 'tiny-abc123.js'), 'export {}\n')
    await writeFile(path.join(dist, 'site.webmanifest'), JSON.stringify({ name: 'fixture', pad: 'x'.repeat(2000) }))
    await writeFile(path.join(dist, 'sw.js'), bigScript)
    await writeFile(path.join(dist, 'brand', 'mark.png'), Buffer.alloc(4096, 7))
    await writeFile(path.join(dist, 'notes.xyz'), 'unknown')
    await mkdir(path.join(root, 'outside'))
    await writeFile(path.join(root, 'outside', 'secret.txt'), 'outside')
    await symlink(path.join(root, 'outside'), path.join(dist, 'escape'))
    const handle = createWebAssetHandler(dist, path.join(dist, 'index.html'))
    declined = []
    server = createServer((req, res) => {
      // Decoded by hand so encoded dot segments reach the handler as a hostile client would send them.
      const pathname = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/')
      handle(req, res, pathname).then(
        (served) => {
          if (served) return
          declined.push(pathname)
          res.writeHead(404)
          res.end()
        },
        () => {
          res.writeHead(500)
          res.end()
        },
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('server did not bind')
    port = address.port
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  })

  it('marks hashed assets immutable and supports revalidation', async () => {
    const first = await get('/assets/index-abc123.js')
    expect(first.status).toBe(200)
    expect(first.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(first.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(first.headers['x-content-type-options']).toBe('nosniff')
    const etag = String(first.headers['etag'])
    expect(etag).toMatch(/^W\//)
    const again = await get('/assets/index-abc123.js', { 'if-none-match': etag })
    expect(again.status).toBe(304)
    expect(again.body.length).toBe(0)
  })

  it('serves other files with no-cache, an etag and 304', async () => {
    const first = await get('/site.webmanifest')
    expect(first.headers['cache-control']).toBe('no-cache')
    expect(first.headers['content-type']).toBe('application/manifest+json')
    const etag = String(first.headers['etag'])
    const again = await get('/site.webmanifest', { 'if-none-match': `"other", ${etag}` })
    expect(again.status).toBe(304)
    expect(again.body.length).toBe(0)
    expect((await get('/sw.js')).headers['cache-control']).toBe('no-cache')
    expect((await get('/brand/mark.png')).headers['cache-control']).toBe('no-cache')
  })

  it('negotiates br, gzip or identity and reports exact lengths', async () => {
    const br = await get('/assets/index-abc123.js', { 'accept-encoding': 'gzip, br' })
    expect(br.headers['content-encoding']).toBe('br')
    expect(br.headers['vary']).toBe('accept-encoding')
    expect(Number(br.headers['content-length'])).toBe(br.body.length)
    expect(brotliDecompressSync(br.body).toString()).toBe(bigScript)

    const gz = await get('/assets/index-abc123.js', { 'accept-encoding': 'gzip' })
    expect(gz.headers['content-encoding']).toBe('gzip')
    expect(Number(gz.headers['content-length'])).toBe(gz.body.length)
    expect(gunzipSync(gz.body).toString()).toBe(bigScript)

    const plain = await get('/assets/index-abc123.js')
    expect(plain.headers['content-encoding']).toBeUndefined()
    expect(Number(plain.headers['content-length'])).toBe(Buffer.byteLength(bigScript))
    expect(plain.body.toString()).toBe(bigScript)

    const refused = await get('/assets/index-abc123.js', { 'accept-encoding': 'br;q=0, gzip' })
    expect(refused.headers['content-encoding']).toBe('gzip')
  })

  it('leaves small and already compressed files alone', async () => {
    const tiny = await get('/assets/tiny-abc123.js', { 'accept-encoding': 'br, gzip' })
    expect(tiny.headers['content-encoding']).toBeUndefined()
    expect(tiny.body.toString()).toBe('export {}\n')
    const png = await get('/brand/mark.png', { 'accept-encoding': 'br, gzip' })
    expect(png.headers['content-encoding']).toBeUndefined()
    expect(png.headers['content-type']).toBe('image/png')
    expect(Number(png.headers['content-length'])).toBe(4096)
    expect(png.body.length).toBe(4096)
  })

  it('compresses a file once for concurrent first requests', async () => {
    const replies = await Promise.all(
      Array.from({ length: 6 }, () => get('/assets/index-abc123.js', { 'accept-encoding': 'br' })),
    )
    for (const reply of replies) expect(brotliDecompressSync(reply.body).toString()).toBe(bigScript)
    expect(reads.files.filter((file) => file.endsWith('index-abc123.js'))).toHaveLength(1)
    // A later request reuses the cached copy.
    await get('/assets/index-abc123.js', { 'accept-encoding': 'br' })
    expect(reads.files.filter((file) => file.endsWith('index-abc123.js'))).toHaveLength(1)
  })

  it('serves new content after the file changes', async () => {
    const before = await get('/sw.js', { 'accept-encoding': 'gzip' })
    expect(gunzipSync(before.body).toString()).toBe(bigScript)
    const file = path.join(dist, 'sw.js')
    await writeFile(file, bigScriptV2)
    const later = new Date(Date.now() + 5000)
    await utimes(file, later, later)
    const after = await get('/sw.js', { 'accept-encoding': 'gzip' })
    expect(gunzipSync(after.body).toString()).toBe(bigScriptV2)
    expect(after.headers['etag']).not.toBe(before.headers['etag'])
    // The old validator no longer matches.
    expect((await get('/sw.js', { 'if-none-match': String(before.headers['etag']) })).status).toBe(200)
  })

  it('declines paths it cannot serve safely', async () => {
    const targets = ['/escape/secret.txt', '/missing.js', '/notes.xyz', '/assets', '/brand', '/index.html']
    for (const target of targets) expect((await get(target)).status, target).toBe(404)
    expect(declined).toEqual(targets)
    // Encoded dot segments and NUL bytes are declined before any file system access.
    expect((await get('/%2e%2e/outside/secret.txt')).status).toBe(404)
    expect((await get('/assets/%00.js')).status).toBe(404)
    expect(declined.slice(-2)).toEqual(['/../outside/secret.txt', '/assets/\0.js'])
  })

  it('answers HEAD with headers only', async () => {
    const head = await get('/assets/index-abc123.js', { 'accept-encoding': 'gzip' }, 'HEAD')
    expect(head.status).toBe(200)
    expect(head.headers['content-encoding']).toBe('gzip')
    expect(Number(head.headers['content-length'])).toBeGreaterThan(0)
    expect(head.body.length).toBe(0)
    const plainHead = await get('/brand/mark.png', {}, 'HEAD')
    expect(plainHead.headers['content-length']).toBe('4096')
    expect(plainHead.body.length).toBe(0)
  })
})
