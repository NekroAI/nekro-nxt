import { createServer } from 'node:net'
import { readFile, writeFile } from 'node:fs/promises'

const listenOnce = (host: string, port: number): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen({ host, port, exclusive: true }, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('无法分配本地 Host 端口。')))
        return
      }
      server.close((error) => {
        if (error) reject(error)
        else resolve(address.port)
      })
    })
  })

/**
 * Picks the local Host port. The page's origin includes the port, and browser storage (theme, density, drafts) is
 * kept per origin, so the port used last time is taken again when it is free; otherwise any free port.
 */
export const reserveLoopbackPort = async (host: string, preferred?: number): Promise<number> => {
  if (preferred !== undefined) {
    try {
      return await listenOnce(host, preferred)
    } catch {
      // Taken by something else this time; a new origin is better than no Host.
    }
  }
  return listenOnce(host, 0)
}

export const readRememberedPort = async (filePath: string): Promise<number | undefined> => {
  try {
    const record: unknown = JSON.parse(await readFile(filePath, 'utf8'))
    const port = typeof record === 'object' && record !== null && 'port' in record ? record.port : undefined
    return typeof port === 'number' && Number.isInteger(port) && port > 1024 && port < 65536 ? port : undefined
  } catch {
    return undefined
  }
}

export const rememberPort = (filePath: string, port: number): Promise<void> =>
  writeFile(filePath, `${JSON.stringify({ port })}\n`, { mode: 0o600 })
