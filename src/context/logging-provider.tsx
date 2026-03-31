import React, { createContext, useContext, useEffect, useMemo, useRef } from 'react'
import { createLogger, type Logger } from '../logger'
import type { LoggerConfig } from '../types'

const LoggerContext = createContext<Logger | null>(null)

interface LoggingProviderProps {
  config: LoggerConfig
  children: React.ReactNode
}

export function LoggingProvider({ config, children }: LoggingProviderProps) {
  // Stable ref to config so the effect doesn't re-run on every render
  const configRef = useRef(config)
  configRef.current = config

  // Create logger once, re-create if destroyed by Strict Mode remount
  const logger = useMemo(() => createLogger(configRef.current), [])

  useEffect(() => {
    // Try to track screen via expo-router
    let unsubscribe: (() => void) | undefined
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { router } = require('expo-router')
      if (router && typeof router.subscribe === 'function') {
        unsubscribe = router.subscribe((state: { routes?: Array<{ name: string }> }) => {
          if (state?.routes?.length) {
            const currentRoute = state.routes[state.routes.length - 1]
            logger.setScreen(currentRoute.name)
          }
        })
      }
    } catch {
      // expo-router not available — screen tracking disabled
    }

    return () => {
      unsubscribe?.()
      logger.destroy()
    }
  }, [logger])

  return (
    <LoggerContext.Provider value={logger}>
      {children}
    </LoggerContext.Provider>
  )
}

export function useLogger(): Logger {
  const logger = useContext(LoggerContext)
  if (!logger) {
    throw new Error('useLogger must be used within a LoggingProvider')
  }
  return logger
}
