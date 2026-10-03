import { EmptyState } from '../../ui-kit/next/index.js'
import { useCrumb } from '../shell/crumb.js'

export default function WiringSpace() {
  useCrumb('接线')
  return <EmptyState title="接线" />
}
