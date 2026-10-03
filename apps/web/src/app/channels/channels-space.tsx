import { EmptyState } from '../../ui-kit/next/index.js'
import { useCrumb } from '../shell/crumb.js'

export default function ChannelsSpace() {
  useCrumb('频道')
  return <EmptyState title="频道" />
}
