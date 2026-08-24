import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { NekroNxtApp } from './app.js'
import { HttpProductHost } from './http-host.js'
import { ProductHostCoordinator } from './product-port.js'
import { setActiveProductHost } from './product-store.js'
import '@glinui/tokens/theme.css'
import './ui-kit/tokens.css'

const reducedMotion = window.localStorage.getItem('nekro-nxt.reduced-motion') === 'true'
const persistedTheme = window.localStorage.getItem('nekro-nxt.theme')
if (persistedTheme === 'light' || persistedTheme === 'dark') {
  document.documentElement.dataset['theme'] = persistedTheme
}
document.documentElement.classList.toggle(
  'dark',
  persistedTheme === 'dark' ||
    (persistedTheme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches),
)
document.documentElement.dataset['reducedMotion'] = String(reducedMotion)
document.documentElement.dataset['nxtMotion'] = reducedMotion ? 'off' : 'on'

const root = document.querySelector('#root')
if (!root) throw new Error('NekroNxt Web root element is missing.')

// Real-Host wiring (design docs/08): stream the authoritative Server projection
// into the Shell and route product actions through the domain API. Without a
// live Server the Shell keeps its local demo data (graded fallback).
const coordinator = new ProductHostCoordinator(new HttpProductHost())
setActiveProductHost(coordinator)
coordinator.start()

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <NekroNxtApp />
    </BrowserRouter>
  </StrictMode>,
)

window.addEventListener('beforeunload', () => {
  coordinator.dispose()
  setActiveProductHost(null)
})
