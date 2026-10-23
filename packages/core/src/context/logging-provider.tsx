import type { Logger } from '../logger'
import type { LoggerConfig } from '../types'
import * as React from 'react'
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { createLogger } from '../logger'
import { setNetworkStateLogger } from '../network-state'

const LoggerContext = createContext<Logger | null>(null)

type LoggingProviderProps = {
  children: React.ReactNode
} & (
  | { config: LoggerConfig, logger?: never }
  /**
   * A logger the app created itself (`createLogger`), so code outside React
   * (db, auth, device machines, module-level loggers) and the tree share ONE
   * instance: one ring buffer for `exportLogs`, one file writer, one
   * sessionId. The app owns it: the provider never destroys it.
   */
  | { logger: Logger, config?: never }
)

export function LoggingProvider(props: LoggingProviderProps) {
  if (props.logger)
    return <SharedLoggingProvider logger={props.logger}>{props.children}</SharedLoggingProvider>
  return <OwnedLoggingProvider config={props.config}>{props.children}</OwnedLoggingProvider>
}

function SharedLoggingProvider({ logger, children }: { logger: Logger, children: React.ReactNode }) {
  useLoggerLifecycle(logger)
  return (
    <LoggerContext.Provider value={logger}>
      {children}
    </LoggerContext.Provider>
  )
}

function OwnedLoggingProvider({ config, children }: { config: LoggerConfig, children: React.ReactNode }) {
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
    return () => {
      destroyedRef.current = true
      logger.destroy().catch((error: unknown) => {
        // The logger is going away; its last batch may not reach the webhook.
        if (__DEV__)
          console.warn('[Logger] destroy failed', String(error))
      })
    }
  }, [logger])

  useLoggerLifecycle(logger)

  return (
    <LoggerContext.Provider value={logger}>
      {children}
    </LoggerContext.Provider>
  )
}

/**
 * What the provider wires around a logger, whoever owns it: connectivity
 * reports, screen tracking, and a flush when the app goes to the background.
 */
function useLoggerLifecycle(logger: Logger): void {
  useEffect(() => {
    // Connectivity changes and polling failures land in this logger.
    setNetworkStateLogger(logger)

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
      // expected: expo-router not available — screen tracking disabled
    }

    return () => {
      unsubscribe?.()
      setNetworkStateLogger(null)
    }
  }, [logger])

  // iOS may suspend or kill a backgrounded app at any moment (a BLE sync
  // wakes it, then it is gone), so whatever is still batched goes to disk on
  // the way out rather than with the next line.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'background' && state !== 'inactive')
        return
      // The logger is alive here, so the failure goes into it (and to the
      // console in dev, as every line does).
      logger.flush().catch((error: unknown) => {
        logger.warn('[Logger] flush on background failed', { error: String(error) })
      })
    })
    return () => subscription.remove()
  }, [logger])
}

export function useLogger(): Logger {
  const logger = useContext(LoggerContext)
  if (!logger) {
    throw new Error('useLogger must be used within a LoggingProvider')
  }
  return logger
}
