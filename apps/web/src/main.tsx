import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { NekroNxtApp } from './app.js'
import { installStableCursorIntent } from './cursor-stability.js'
import { createProductRuntime, ProductRuntimeProvider } from './product-runtime.js'
import { applyThemeChoice, readInitialThemeChoice } from './theme-preference.js'
import '@glinui/tokens/theme.css'
import './ui-kit/tokens.css'

const reducedMotion = window.localStorage.getItem('nekro-nxt.reduced-motion') === 'true'
applyThemeChoice(document.documentElement, readInitialThemeChoice())
document.documentElement.dataset['reducedMotion'] = String(reducedMotion)
document.documentElement.dataset['nxtMotion'] = reducedMotion ? 'off' : 'on'
const disposeStableCursorIntent = installStableCursorIntent()

const root = document.querySelector('#root')
if (!root) throw new Error('NekroNxt Web root element is missing.')

// The transport and product actions share the runtime's single authoritative store.
const runtime = createProductRuntime()
const unsubscribeHost = runtime.host.subscribe(() => undefined)

createRoot(root).render(
  <StrictMode>
    <ProductRuntimeProvider runtime={runtime}>
      <BrowserRouter>
        <NekroNxtApp />
      </BrowserRouter>
    </ProductRuntimeProvider>
  </StrictMode>,
)

window.addEventListener('beforeunload', () => {
  disposeStableCursorIntent()
  unsubscribeHost()
})
