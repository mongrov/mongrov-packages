/**
 * @jest-environment jsdom
 */
import React from 'react'
import { renderHook } from '@testing-library/react'
import { LoggingProvider, useLogger } from '../context/logging-provider'

// Mock react-native
jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}))

// Mock network-state
jest.mock('../network-state', () => ({
  getNetworkState: jest.fn(async () => ({
    isConnected: true,
    type: 'wifi',
    isInternetReachable: true,
  })),
  addNetworkStateListener: jest.fn(() => ({ remove: jest.fn() })),
}))

// @ts-expect-error global __DEV__
global.__DEV__ = true

describe('LoggingProvider', () => {
  it('should render children and provide logger via useLogger', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <LoggingProvider config={{ appVersion: '1.0.0', ringBuffer: true }}>
        {children}
      </LoggingProvider>
    )

    const { result } = renderHook(() => useLogger(), { wrapper })

    expect(result.current).toBeDefined()
    expect(result.current.info).toBeDefined()
    expect(result.current.debug).toBeDefined()
    expect(result.current.warn).toBeDefined()
    expect(result.current.error).toBeDefined()
    expect(result.current.getLogs).toBeDefined()
  })

  it('should throw if useLogger is used outside LoggingProvider', () => {
    // Suppress console.error from React error boundary
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation()

    expect(() => {
      renderHook(() => useLogger())
    }).toThrow('useLogger must be used within a LoggingProvider')

    consoleSpy.mockRestore()
  })

  it('should create a functional logger that can log and retrieve entries', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <LoggingProvider config={{ appVersion: '1.0.0', ringBuffer: true }}>
        {children}
      </LoggingProvider>
    )

    const { result } = renderHook(() => useLogger(), { wrapper })

    result.current.info('test from provider')

    await new Promise((r) => setTimeout(r, 10))

    const logs = result.current.getLogs()
    expect(logs).toHaveLength(1)
    expect(logs[0].message).toBe('test from provider')
  })
})
