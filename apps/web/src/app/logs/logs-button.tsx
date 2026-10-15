import { ScrollText } from 'lucide-react'
import type { HostLogQuery } from '@nekro-nxt/contracts'
import { Button } from '../../ui-kit/index.js'
import { useGo } from '../model/nav.js'
import { logHref } from './logs-api.js'

export function LogsButton({ query }: { readonly query: HostLogQuery }) {
  const go = useGo()
  return (
    <Button size="small" variant="ghost" icon={<ScrollText size={14} />} onClick={() => go(logHref(query))}>
      查看日志
    </Button>
  )
}
