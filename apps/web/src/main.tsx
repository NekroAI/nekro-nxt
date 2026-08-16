import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { NekroNxtApp } from './app.js'
import './ui-kit/tokens.css'

const root = document.querySelector('#root')
if (!root) throw new Error('NekroNxt Web root element is missing.')

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <NekroNxtApp />
    </BrowserRouter>
  </StrictMode>,
)
