import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = (packageName, file = 'src/index.ts') => `${root}/packages/${packageName}/${file}`

export const workspaceSourceAliases = {
  '@nekro-nxt/dsh-compat/client': source('dsh-compat', 'src/client.ts'),
  '@nekro-nxt/dsh-compat': source('dsh-compat'),
  '@nekro-nxt/adapter-sdk': source('adapter-sdk'),
  '@nekro-nxt/adapter-onebot-11': source('adapter-onebot-11'),
  '@nekro-nxt/adapter-qq-openclaw': source('adapter-qq-openclaw'),
  '@nekro-nxt/adapter-web': source('adapter-web'),
  '@nekro-nxt/client-migrations': source('client-migrations'),
  '@nekro-nxt/contracts': source('contracts'),
  '@nekro-nxt/core': source('core'),
  '@nekro-nxt/extension-sdk': source('extension-sdk'),
  '@nekro-nxt/extension-runtime': source('extension-runtime'),
  '@nekro-nxt/channel-runtime': source('channel-runtime'),
  '@nekro-nxt/storage-sqlite': source('storage-sqlite'),
  '@nekro-nxt/test-harness': source('test-harness'),
}
