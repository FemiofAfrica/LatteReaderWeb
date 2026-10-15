import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { installGlobalDiagnostics } from './diagnostics/diagnostics'
import { initAnalytics } from './analytics/analytics'
import { ConsentBanner } from './analytics/ConsentBanner'
installGlobalDiagnostics()
initAnalytics()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <ConsentBanner />
  </StrictMode>,
)
