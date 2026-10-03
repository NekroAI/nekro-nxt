import { EmptyState } from '../../ui-kit/next/index.js'
import { useCrumb } from '../shell/crumb.js'

export default function LiveSpace() {
  useCrumb('现场')
  return <EmptyState title="现场" />
}
