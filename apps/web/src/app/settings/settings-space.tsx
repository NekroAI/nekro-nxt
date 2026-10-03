import { EmptyState } from '../../ui-kit/next/index.js'
import { useCrumb } from '../shell/crumb.js'

export default function SettingsSpace() {
  useCrumb('设置')
  return <EmptyState title="设置" />
}
