/** @jest-environment jsdom */
import { act, renderHook } from '@testing-library/react'
import {
  __setAuthResult,
  __setAvailable,
  __setEnrolled,
  __reset as resetLocalAuth,
} from '../../__mocks__/expo-local-authentication'
import { __resetBiometricModule, useBiometricGate } from '../biometric'

beforeEach(() => {
  __resetBiometricModule()
  resetLocalAuth()
})

describe('useBiometricGate', () => {
  it('detects available biometrics', async () => {
    __setAvailable(true)
    __setEnrolled(true)

    const { result } = renderHook(() => useBiometricGate())

    // Wait for effect to run
    await act(async () => {
      await new Promise(r => setTimeout(r, 0))
    })

    expect(result.current.isAvailable).toBe(true)
    expect(result.current.isAuthenticated).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('detects unavailable when no hardware', async () => {
    __setAvailable(false)
    __setEnrolled(true)

    const { result } = renderHook(() => useBiometricGate())

    await act(async () => {
      await new Promise(r => setTimeout(r, 0))
    })

    expect(result.current.isAvailable).toBe(false)
  })

  it('detects unavailable when not enrolled', async () => {
    __setAvailable(true)
    __setEnrolled(false)

    const { result } = renderHook(() => useBiometricGate())

    await act(async () => {
      await new Promise(r => setTimeout(r, 0))
    })

    expect(result.current.isAvailable).toBe(false)
  })

  it('authenticate returns success', async () => {
    __setAvailable(true)
    __setEnrolled(true)
    __setAuthResult(true)

    const { result } = renderHook(() => useBiometricGate())

    await act(async () => {
      await new Promise(r => setTimeout(r, 0))
    })

    let success: boolean
    await act(async () => {
      success = await result.current.authenticate('Verify identity')
    })

    expect(success!).toBe(true)
    expect(result.current.isAuthenticated).toBe(true)
  })

  it('authenticate returns failure', async () => {
    __setAvailable(true)
    __setEnrolled(true)
    __setAuthResult(false)

    const { result } = renderHook(() => useBiometricGate())

    await act(async () => {
      await new Promise(r => setTimeout(r, 0))
    })

    let success: boolean
    await act(async () => {
      success = await result.current.authenticate()
    })

    expect(success!).toBe(false)
    expect(result.current.isAuthenticated).toBe(false)
  })
})
