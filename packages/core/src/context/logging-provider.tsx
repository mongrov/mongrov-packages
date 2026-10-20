import type { Logger } from '../logger'
import type { LoggerConfig } from '../types'
import * as React from 'react'
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { createLogger } from '../logger'

const LoggerContext = createContext<Logger | null>(null)

interface LoggingProviderProps {
  config: LoggerConfig
  children: React.ReactNode
}

export function LoggingProvider({ config, children }: LoggingProviderProps) {
  // The config is read when a logger is created; later changes to it are not
  // applied to a live logger.
  const configRef = useRef(config)
  configRef.current = config

  const [logger, setLogger] = useState(() => createLogger(config))
  // Set by the effect cleanup. A cleanup is not always a real unmount: Strict
  // Mode and Fast Refresh run cleanup then the effect again on the SAME
  // component, which used to keep handing out a destroyed logger (webhook
  // timer stopped, offline queue gone). A re-run that finds the logger
  // destroyed replaces it.
  const destroyedRef = useRef(false)

  useEffect(() => {
    if (destroyedRef.current) {
      destroyedRef.current = false
      // eslint-disable-next-line react-hooks-extra/no-direct-set-state-in-use-effect -- replacing a destroyed logger is the point of this branch
      setLogger(createLogger(configRef.current))
      return
    }

    // Try to track screen via expo-router
    let unsubscribe: (() => void) | undefined
    try {
      const { router } = require('expo-router')
      if (router && typeof router.subscribe === 'function') {
        unsubscribe = router.subscribe((state: { routes?: Array<{ name: string }> }) => {
          if (state?.routes?.length) {
            const currentRoute = state.routes[state.routes.length - 1]
            logger.setScreen(currentRoute.name)
          }
        })
      }
    }
    catch {
      // expo-router not available — screen tracking disabled
    }

    return () => {
      unsubscribe?.()
      destroyedRef.current = true
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
