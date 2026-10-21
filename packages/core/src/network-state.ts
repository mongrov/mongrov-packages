import type { InternalLogger } from './internal-log'
import { devConsoleLogger, FailureGate } from './internal-log'

export interface NetworkState {
  isConnected: boolean
  type: string | null
  isInternetReachable: boolean | null
}

type NetworkStateListener = (state: NetworkState) => void

let cachedState: NetworkState = {
  isConnected: true,
  type: null,
  isInternetReachable: null,
}

const listeners = new Set<NetworkStateListener>()
let pollingInterval: ReturnType<typeof setInterval> | null = null

// Module state has no logger of its own; `LoggingProvider` sets the app's.
let log: InternalLogger = devConsoleLogger()
const pollFailures = new FailureGate()

/**
 * Where connectivity changes and polling failures are reported. Called by
 * `LoggingProvider`; `null` restores the dev-console fallback.
 */
export function setNetworkStateLogger(logger: InternalLogger | null): void {
  log = logger ?? devConsoleLogger()
}

function getExpoNetwork() {
  try {
    return require('expo-network')
  }
  catch {
    throw new Error(
      '@mongrov/core network-state requires expo-network as a peer dependency',
    )
  }
}

async function fetchNetworkState(): Promise<NetworkState> {
  const Network = getExpoNetwork()
  const state = await Network.getNetworkStateAsync()
  return {
    isConnected: state.isConnected ?? false,
    type: state.type ?? null,
    isInternetReachable: state.isInternetReachable ?? null,
  }
}

async function pollAndNotify(): Promise<void> {
  try {
    const newState = await fetchNetworkState()
    const changed
      = newState.isConnected !== cachedState.isConnected
        || newState.type !== cachedState.type
        || newState.isInternetReachable !== cachedState.isInternetReachable

    const previous = cachedState
    cachedState = newState

    const failed = pollFailures.recover()
    if (failed > 0)
      log.info('[Network] state readable again', { failedPolls: failed })

    if (changed) {
      log.info('[Network] state changed', {
        isConnected: newState.isConnected,
        type: newState.type,
        isInternetReachable: newState.isInternetReachable,
        wasConnected: previous.isConnected,
      })
      notify(newState)
    }
  }
  catch (error) {
    // The cached state stays as it was; listeners hear nothing until a poll
    // succeeds. Reported once per run of failures (polls every 15s).
    if (pollFailures.fail())
      log.warn('[Network] state poll failed; keeping last known state', { error: String(error) })
  }
}

function notify(state: NetworkState): void {
  listeners.forEach((cb) => {
    // One throwing listener must not starve the others.
    try {
      cb(state)
    }
    catch (error) {
      log.error('[Network] listener threw', { error: String(error) })
    }
  })
}

function startPolling(): void {
  if (pollingInterval)
    return
  void pollAndNotify() // never rejects: failures are reported inside
  pollingInterval = setInterval(pollAndNotify, 15000)
}

function stopPolling(): void {
  if (pollingInterval) {
    clearInterval(pollingInterval)
    pollingInterval = null
  }
}

export async function getNetworkState(): Promise<NetworkState> {
  cachedState = await fetchNetworkState()
  return cachedState
}

export function addNetworkStateListener(
  callback: NetworkStateListener,
): { remove: () => void } {
  listeners.add(callback)
  if (listeners.size === 1) {
    startPolling()
  }

  return {
    remove: () => {
      listeners.delete(callback)
      if (listeners.size === 0) {
        stopPolling()
      }
    },
  }
}

// React hook — only usable in components
export function useNetworkState(): NetworkState {
  // Lazy import React to avoid issues in non-React contexts

  const React = require('react') as typeof import('react')
  const { useState, useEffect } = React

  const [state, setState] = useState<NetworkState>(cachedState)

  useEffect(() => {
    getNetworkState().then(setState, (error: unknown) => {
      // Keeps the cached state; the listener below picks up the next poll.
      log.warn('[Network] initial state read failed', { error: String(error) })
    })
    const subscription = addNetworkStateListener(setState)
    return () => subscription.remove()
  }, [])

  return state
}
