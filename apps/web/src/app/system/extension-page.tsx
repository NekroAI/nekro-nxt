import { useParams } from 'react-router-dom'
import { HostUiObjectPane, HostUiPageCanvas } from '../../host-ui-client.js'
import { useProductStore } from '../../product-runtime.js'
import { useCrumb } from '../shell/crumb.js'
import styles from './extension-page.module.css'

/**
 * Extension-owned page. The Host UI runtime renders the content; pages that declare their own navigation get a
 * list column like every other space.
 */
export function ExtensionPage() {
  const { pageInstanceId } = useParams()
  const page = useProductStore((state) => state.hostUi.pages.find((item) => item.pageInstanceId === pageInstanceId))
  useCrumb('扩展页面', page?.title)
  if (page?.objectPane !== 'navigation') return <HostUiPageCanvas />
  return (
    <div className={styles.extensionPage}>
      <aside className={styles.extensionNavigation} aria-label={`${page.title}导航`}>
        <HostUiObjectPane page={page} />
      </aside>
      <div className={styles.extensionCanvas}>
        <HostUiPageCanvas />
      </div>
    </div>
  )
}
