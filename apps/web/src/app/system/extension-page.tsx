import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { ChevronLeft } from 'lucide-react'
import type { HostUiPageEntry } from '@nekro-nxt/contracts'
import { HostUiObjectPane, HostUiPageCanvas } from '../../host-ui-client.js'
import { useProductStore } from '../../product-runtime.js'
import { Button } from '../../ui-kit/index.js'
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
  return <NavigationPage key={page.pageInstanceId} page={page} />
}

function NavigationPage({ page }: { readonly page: HostUiPageEntry }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const atRoot = pathname.replace(/\/$/u, '') === page.routeBase.replace(/\/$/u, '')
  const [showNavigation, setShowNavigation] = useState(atRoot)
  useEffect(() => setShowNavigation(atRoot), [atRoot, pathname])
  return (
    <div className={styles.extensionPage} data-navigation={showNavigation}>
      <aside className={styles.extensionNavigation} aria-label={`${page.title}导航`}>
        <HostUiObjectPane page={page} onNavigate={() => setShowNavigation(false)} />
      </aside>
      <div className={styles.extensionCanvas}>
        <div className={styles.navigationBack}>
          <Button
            variant="ghost"
            size="small"
            icon={<ChevronLeft size={15} />}
            onClick={() => {
              setShowNavigation(true)
              void navigate(page.routeBase)
            }}
          >
            返回列表
          </Button>
        </div>
        <HostUiPageCanvas />
      </div>
    </div>
  )
}
