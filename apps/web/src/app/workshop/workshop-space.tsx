import { EmptyState } from '../../ui-kit/next/index.js'
import { useCrumb } from '../shell/crumb.js'

export default function WorkshopSpace() {
  useCrumb('工坊')
  return <EmptyState title="工坊" />
}
