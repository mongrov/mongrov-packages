// We need to test the real network-state module, so mock only expo-network
const mockGetNetworkStateAsync = jest.fn()

jest.mock('expo-network', () => ({
  getNetworkStateAsync: mockGetNetworkStateAsync,
  NetworkStateType: { NONE: 0, WIFI: 1, CELLULAR: 2 },
}))

// Must import AFTER mocking
import { getNetworkState, addNetworkStateListener } from '../network-state'

describe('NetworkState', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    mockGetNetworkStateAsync.mockResolvedValue({
      isConnected: true,
      type: 1,
      isInternetReachable: true,
    })
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('should fetch and return network state', async () => {
    const state = await getNetworkState()

    expect(mockGetNetworkStateAsync).toHaveBeenCalledTimes(1)
    expect(state.isConnected).toBe(true)
    expect(state.isInternetReachable).toBe(true)
  })

  it('should handle missing fields with defaults', async () => {
    mockGetNetworkStateAsync.mockResolvedValueOnce({})

    const state = await getNetworkState()

    expect(state.isConnected).toBe(false)
    expect(state.type).toBeNull()
    expect(state.isInternetReachable).toBeNull()
  })

  it('should start polling when first listener is added', async () => {
    const listener = jest.fn()
    const sub = addNetworkStateListener(listener)

    // pollAndNotify is called immediately on startPolling
    await Promise.resolve()
    expect(mockGetNetworkStateAsync).toHaveBeenCalled()

    sub.remove()
  })

  it('should notify listener when state changes', async () => {
    mockGetNetworkStateAsync.mockResolvedValueOnce({
      isConnected: true,
      type: 1,
      isInternetReachable: true,
    })

    const listener = jest.fn()
    const sub = addNetworkStateListener(listener)

    // Let initial poll resolve
    await Promise.resolve()
    await Promise.resolve()

    // Change state and advance timer
    mockGetNetworkStateAsync.mockResolvedValueOnce({
      isConnected: false,
      type: 0,
      isInternetReachable: false,
    })

    jest.advanceTimersByTime(15000)
    await Promise.resolve()
    await Promise.resolve()

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ isConnected: false })
    )

    sub.remove()
  })

  it('should not notify listener when state has not changed', async () => {
    // Same state on both polls
    mockGetNetworkStateAsync.mockResolvedValue({
      isConnected: true,
      type: 1,
      isInternetReachable: true,
    })

    const listener = jest.fn()
    const sub = addNetworkStateListener(listener)

    // Initial poll
    await Promise.resolve()
    await Promise.resolve()
    listener.mockClear()

    // Advance to next poll — same state, no notification
    jest.advanceTimersByTime(15000)
    await Promise.resolve()
    await Promise.resolve()

    expect(listener).not.toHaveBeenCalled()

    sub.remove()
  })

  it('should stop polling when last listener is removed', async () => {
    const listener1 = jest.fn()
    const listener2 = jest.fn()
    const sub1 = addNetworkStateListener(listener1)
    const sub2 = addNetworkStateListener(listener2)

    await Promise.resolve()
    mockGetNetworkStateAsync.mockClear()

    sub1.remove()
    // Still one listener — polling continues
    jest.advanceTimersByTime(15000)
    await Promise.resolve()
    expect(mockGetNetworkStateAsync).toHaveBeenCalled()

    mockGetNetworkStateAsync.mockClear()
    sub2.remove()
    // No listeners — polling should stop
    jest.advanceTimersByTime(15000)
    await Promise.resolve()
    expect(mockGetNetworkStateAsync).not.toHaveBeenCalled()
  })

  it('should handle poll errors gracefully', async () => {
    const listener = jest.fn()
    const sub = addNetworkStateListener(listener)

    await Promise.resolve()
    listener.mockClear()

    // Poll throws
    mockGetNetworkStateAsync.mockRejectedValueOnce(new Error('no network module'))

    jest.advanceTimersByTime(15000)
    await Promise.resolve()
    await Promise.resolve()

    // Should not crash, listener should not be called
    expect(listener).not.toHaveBeenCalled()

    sub.remove()
  })
})
