import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { DataProvider } from './hooks/useData.jsx'
import './styles/tokens.css'
import './styles/app.css'
import { applyTheme, getStoredTheme } from './lib/theme'

// 渲染前先应用主题，避免首屏闪白（浅色→深色的跳变）
applyTheme(getStoredTheme())

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <DataProvider>
        <App />
      </DataProvider>
    </ErrorBoundary>
  </React.StrictMode>,
)
