import { commandCredentialsOf, useCredentials } from '../../credentials/credentials-data.js'
import { Button, PropertyRow } from '../../ui-kit/index.js'
import { useGo } from '../model/nav.js'

/**
 * Credentials this agent's commands receive, read-only: which ones is decided on each credential (设置 → 凭据), not
 * on the agent.
 */
export function CommandCredentialRows({ agentId }: { readonly agentId: string }) {
  const { view } = useCredentials()
  const go = useGo()
  if (view === undefined) return null
  const received = commandCredentialsOf(view.credentials, agentId)
  return (
    <PropertyRow
      depth={1}
      label="命令可用的凭据"
      description={
        received.length === 0 ? '无' : received.map(({ credential, env }) => `${credential.name}（${env}）`).join('、')
      }
    >
      <Button size="small" variant="ghost" onClick={() => go('/settings/credentials')}>
        管理凭据
      </Button>
    </PropertyRow>
  )
}
