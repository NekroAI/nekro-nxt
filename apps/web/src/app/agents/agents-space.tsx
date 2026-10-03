import { EmptyState } from '../../ui-kit/next/index.js'
import { useCrumb } from '../shell/crumb.js'

export default function AgentsSpace() {
  useCrumb('智能体')
  return <EmptyState title="智能体" />
}
