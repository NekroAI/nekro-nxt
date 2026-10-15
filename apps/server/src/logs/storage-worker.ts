import { parentPort, workerData } from 'node:worker_threads'
import { mkdir, chmod, lstat } from 'node:fs/promises'
import path from 'node:path'
import { LogDatabase } from '@nekro-nxt/storage-sqlite'
import { hostLogSettingsSchema, hostLogQuerySchema, hostLogEntrySchema } from '@nekro-nxt/contracts'
import { z } from 'zod'

const config = z.object({ dataRoot: z.string(), settings: hostLogSettingsSchema }).parse(workerData)
await mkdir(path.join(config.dataRoot, 'logs'), { recursive: true, mode: 0o700 })
const directory = await lstat(path.join(config.dataRoot, 'logs'))
if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('日志目录不是普通目录，原文件已保留。')
const file = path.join(config.dataRoot, 'logs', 'logs.sqlite')
for (const suffix of ['', '-wal', '-shm']) {
  const info = await lstat(`${file}${suffix}`).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  })
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('日志文件不是普通文件，原文件已保留。')
}
const db = new LogDatabase(file, config.settings)
await chmod(file, 0o600)
const cancelled = new Set<number>()
const requestSchema = z.object({ id: z.number(), method: z.string(), args: z.unknown().optional() })
let tail = Promise.resolve()
parentPort!.on('message', (raw: unknown) => {
  const request = requestSchema.parse(raw)
  if (request.method === 'cancel') {
    cancelled.add(request.id)
    return
  }
  tail = tail.then(async () => {
    let result: unknown
    try {
      switch (request.method) {
        case 'append': {
          const entries = z
            .array(hostLogEntrySchema.omit({ id: true, sequence: true }).extend({ receipt: z.string() }))
            .parse(request.args)
          try {
            result = db.append(entries)
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'SQLITE_FULL')) throw error
            db.cleanup(Date.now(), true)
            result = db.append(entries)
          }
          break
        }
        case 'query':
          result = db.query(hostLogQuerySchema.parse(request.args))
          break
        case 'get':
          result = db.get(z.string().parse(request.args))
          break
        case 'sources':
          result = db.sources()
          break
        case 'stats':
          result = db.stats()
          break
        case 'cleanup':
          db.cleanup(z.number().parse(request.args))
          result = db.stats()
          break
        case 'settings':
          db.configure(hostLogSettingsSchema.parse(request.args))
          db.cleanup(Date.now())
          result = true
          break
        case 'export': {
          const args = z.object({ query: hostLogQuerySchema, format: z.enum(['text', 'jsonl']) }).parse(request.args)
          result = await db.export(args.query, args.format, () => cancelled.has(request.id))
          break
        }
        case 'close':
          db.close()
          result = true
          break
        default:
          throw new Error('日志工作线程不支持此操作。')
      }
      parentPort!.postMessage({ id: request.id, result })
    } catch (error) {
      parentPort!.postMessage({ id: request.id, error: error instanceof Error ? error.message : '日志存储失败。' })
    } finally {
      cancelled.delete(request.id)
    }
  })
})
parentPort!.postMessage({ ready: true })
