import { lazy, Suspense, type ReactNode } from 'react'
import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import { useProductStore } from '../product-runtime.js'
import { AdapterHostClientProvider } from '../adapter-host-client.js'
import { DynamicClientProvider } from '../dynamic-client-coordinator.js'
import { HostUiClientProvider, HostUiPageCanvas } from '../host-ui-client.js'
import { PersistentExtensionClientProvider } from '../persistent-extension-client.js'
import { Skeleton, Toaster, TooltipProvider } from '../ui-kit/next/index.js'
import { AppShell } from './shell/app-shell.js'
import { CrumbProvider, useCrumb } from './shell/crumb.js'
import { useAppearanceEffects } from './model/theme.js'

const LiveSpace = lazy(() => import('./live/live-space.js'))
const ChannelsSpace = lazy(() => import('./channels/channels-space.js'))
const AgentsSpace = lazy(() => import('./agents/agents-space.js'))
const WorkshopSpace = lazy(() => import('./workshop/workshop-space.js'))
const WiringSpace = lazy(() => import('./wiring/wiring-space.js'))
const SettingsSpace = lazy(() => import('./settings/settings-space.js'))

function Loading() {
  return (
    <div style={{ display: 'grid', gap: 12, padding: 32, maxWidth: 720 }}>
      <Skeleton width="40%" height={24} />
      <Skeleton height={14} />
      <Skeleton width="70%" height={14} />
    </div>
  )
}

/** Extension-owned page: the Host UI runtime renders it; the shell only names it. */
function ExtensionPage() {
  const { pageInstanceId } = useParams()
  const title = useProductStore(
    (state) => state.hostUi.pages.find((page) => page.pageInstanceId === pageInstanceId)?.title,
  )
  useCrumb('扩展页面', title)
  return <HostUiPageCanvas />
}

const space = (node: ReactNode) => <Suspense fallback={<Loading />}>{node}</Suspense>

/**
 * The redesigned client (Decision 2026-10-04). Extension runtimes stay mounted for the whole session so dynamic
 * candidates can be verified in the browser and installed pages keep their state across spaces.
 */
export function NextApp() {
  useAppearanceEffects()
  return (
    <DynamicClientProvider>
      <AdapterHostClientProvider>
        <PersistentExtensionClientProvider>
          <HostUiClientProvider>
            <TooltipProvider>
              <CrumbProvider>
                <Routes>
                  <Route element={<AppShell />}>
                    <Route index element={<Navigate to="/live" replace />} />
                    <Route path="live" element={space(<LiveSpace />)} />
                    <Route path="channels/:channelId?" element={space(<ChannelsSpace />)} />
                    <Route path="agents/:agentId?" element={space(<AgentsSpace />)} />
                    <Route path="workshop/*" element={space(<WorkshopSpace />)} />
                    <Route path="wiring/*" element={space(<WiringSpace />)} />
                    <Route path="settings/:section?" element={space(<SettingsSpace />)} />
                    <Route path="apps/:pageInstanceId/*" element={<ExtensionPage />} />
                    <Route path="*" element={<Navigate to="/live" replace />} />
                  </Route>
                </Routes>
                <Toaster />
              </CrumbProvider>
            </TooltipProvider>
          </HostUiClientProvider>
        </PersistentExtensionClientProvider>
      </AdapterHostClientProvider>
    </DynamicClientProvider>
  )
}
