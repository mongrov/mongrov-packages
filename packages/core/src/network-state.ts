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

function getExpoNetwork() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('expo-network')
  } catch {
    throw new Error(
      '@mongrov/core network-state requires expo-network as a peer dependency'
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
    const changed =
      newState.isConnected !== cachedState.isConnected ||
      newState.type !== cachedState.type ||
      newState.isInternetReachable !== cachedState.isInternetReachable

    cachedState = newState

    if (changed) {
      listeners.forEach((cb) => cb(newState))
    }
  } catch {
    // Silently ignore polling errors
  }
}

function startPolling(): void {
  if (pollingInterval) return
  pollAndNotify()
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
  callback: NetworkStateListener
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
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const React = require('react') as typeof import('react')
  const { useState, useEffect } = React

  const [state, setState] = useState<NetworkState>(cachedState)

  useEffect(() => {
    getNetworkState().then(setState)
    const subscription = addNetworkStateListener(setState)
    return () => subscription.remove()
  }, [])

  return state
}
