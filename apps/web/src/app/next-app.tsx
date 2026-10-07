import { lazy, Suspense, useEffect, type ComponentType, type ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { ExtensionUiProvider } from '../extension-ui/index.js'
import { DynamicClientProvider } from '../dynamic-client-coordinator.js'
import { HostUiClientProvider } from '../host-ui-client.js'
import { Skeleton, Toaster, TooltipProvider } from '../ui-kit/index.js'
import { AppShell } from './shell/app-shell.js'
import { CrumbProvider } from './shell/crumb.js'
import { ExtensionPage } from './system/extension-page.js'
import { SpaceBoundary } from './system/space-boundary.js'
import { useAppearanceEffects } from './model/theme.js'
import { readDensity } from './model/density.js'

/**
 * A space loaded on demand that renders synchronously once its module is in memory. `React.lazy` alone would still
 * suspend for one frame on first render even after a prefetch, flashing the skeleton between spaces.
 */
function preloadable(load: () => Promise<{ readonly default: ComponentType }>) {
  let Loaded: ComponentType | undefined
  const remember = () =>
    load().then((module) => {
      Loaded = module.default
      return module
    })
  // React.lazy keeps a rejected import forever; a retry needs a fresh lazy component.
  let Lazy = lazy(remember)
  function Space() {
    return Loaded ? <Loaded /> : <Lazy />
  }
  return {
    Space,
    preload: () => remember().then(() => undefined),
    reset: () => {
      if (!Loaded) Lazy = lazy(remember)
    },
  }
}

const live = preloadable(() => import('./live/live-space.js'))
const channels = preloadable(() => import('./channels/channels-space.js'))
const agents = preloadable(() => import('./agents/agents-space.js'))
const workshop = preloadable(() => import('./workshop/workshop-space.js'))
const community = preloadable(() => import('./community/community-space.js'))
const wiring = preloadable(() => import('./wiring/wiring-space.js'))
const settings = preloadable(() => import('./settings/settings-space.js'))
const LiveSpace = live.Space
const ChannelsSpace = channels.Space
const AgentsSpace = agents.Space
const WorkshopSpace = workshop.Space
const CommunitySpace = community.Space
const WiringSpace = wiring.Space
const SettingsSpace = settings.Space

/** Loads every space once the first screen is idle, so switching spaces never waits on a skeleton. */
function usePrefetchSpaces(): void {
  useEffect(() => {
    const load = () => {
      for (const space of [live, channels, agents, workshop, community, wiring, settings])
        void space.preload().catch(() => undefined)
    }
    if ('requestIdleCallback' in window) {
      const handle = window.requestIdleCallback(load, { timeout: 2000 })
      return () => window.cancelIdleCallback(handle)
    }
    const timer = setTimeout(load, 800)
    return () => clearTimeout(timer)
  }, [])
}

function Loading() {
  return (
    <div style={{ display: 'grid', gap: 12, padding: 32, maxWidth: 720 }}>
      <Skeleton width="40%" height={24} />
      <Skeleton height={14} />
      <Skeleton width="70%" height={14} />
    </div>
  )
}

const retrySpaces = () => {
  for (const item of [live, channels, agents, workshop, community, wiring, settings]) item.reset()
}

const space = (node: ReactNode) => (
  <SpaceBoundary onRetry={retrySpaces}>
    <Suspense fallback={<Loading />}>{node}</Suspense>
  </SpaceBoundary>
)

/**
 * The redesigned client (Decision 2026-10-04). Extension runtimes stay mounted for the whole session so dynamic
 * candidates can be verified in the browser and installed pages keep their state across spaces.
 */
// Apply the saved density before the first paint so sizes do not jump.
if (typeof window !== 'undefined') readDensity()

export function NextApp() {
  useAppearanceEffects()
  usePrefetchSpaces()
  return (
    <DynamicClientProvider>
      <ExtensionUiProvider>
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
                  <Route path="community/*" element={space(<CommunitySpace />)} />
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
      </ExtensionUiProvider>
    </DynamicClientProvider>
  )
}
