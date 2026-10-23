import type { LogEntry } from '../types'
import * as ExpoFileSystem from 'expo-file-system'
import { AppState } from 'react-native'
import { createLogger } from '../logger'
import { SESSION_MARKER_FILE } from '../session-marker'

jest.mock('../network-state', () => ({
  getNetworkState: jest.fn(async () => ({ isConnected: true, type: 'wifi', isInternetReachable: true })),
  addNetworkStateListener: jest.fn(() => ({ remove: jest.fn() })),
}))

// @ts-expect-error global __DEV__
global.__DEV__ = false

const mockFs = ExpoFileSystem as unknown as {
  writeAsStringAsync: jest.Mock
  readAsStringAsync: jest.Mock
  getInfoAsync: jest.Mock
  __mockFiles: Record<string, string>
}
const appState = AppState as unknown as { __emit: (state: string) => void }

const MARKER = `/mock/documents/logs/${SESSION_MARKER_FILE}`

function previous(state: string, extra: Record<string, unknown> = {}): void {
  mockFs.__mockFiles[MARKER] = JSON.stringify({
    sessionId: 'prev-123',
    startedAt: '2026-10-22T10:00:00.000Z',
    updatedAt: '2026-10-22T10:05:00.000Z',
    state,
    ...extra,
  })
}

function markerOnDisk(): Record<string, unknown> {
  return JSON.parse(mockFs.__mockFiles[MARKER])
}

const settle = () => new Promise(r => setTimeout(r, 10))

function started(): { entries: () => LogEntry[], logger: ReturnType<typeof createLogger> } {
  const logger = createLogger({ appVersion: '1.0.0', ringBuffer: true, sessionMarker: true })
  return { logger, entries: () => logger.getLogs() }
}

beforeEach(() => {
  for (const k of Object.keys(mockFs.__mockFiles)) delete mockFs.__mockFiles[k]
  jest.clearAllMocks()
})

describe('session marker', () => {
  it('reports a previous session that died in the foreground, once, at warn', async () => {
    previous('running', { lastCrashReportId: 'sentry-abc' })
    const { logger, entries } = started()
    await settle()

    const unclean = entries().filter(e => e.message === 'logger.session.unclean-exit')
    expect(unclean).toHaveLength(1)
    expect(unclean[0].level).toBe('warn')
    expect(unclean[0].data).toEqual({
      previousSessionId: 'prev-123',
      startedAt: '2026-10-22T10:00:00.000Z',
      lastSeenAt: '2026-10-22T10:05:00.000Z',
      lastCrashReportId: 'sentry-abc',
    })
    // This session is now the one marked running.
    expect(markerOnDisk()).toMatchObject({ sessionId: logger.sessionId, state: 'running' })
    await logger.destroy()
  })

  it('logs a session that ended in the background at info, not as unclean', async () => {
    previous('backgrounded')
    const { logger, entries } = started()
    await settle()

    expect(entries().some(e => e.message === 'logger.session.unclean-exit')).toBe(false)
    const ended = entries().filter(e => e.message === 'logger.session.ended-in-background')
    expect(ended).toHaveLength(1)
    expect(ended[0].level).toBe('info')
    expect(ended[0].data).toMatchObject({ previousSessionId: 'prev-123' })
    await logger.destroy()
  })

  it('says nothing about a previous session that closed', async () => {
    previous('closed')
    const { logger, entries } = started()
    await settle()
    expect(entries().filter(e => e.message.startsWith('logger.session.'))).toEqual([])
    await logger.destroy()
  })

  it('says nothing on a first launch', async () => {
    const { logger, entries } = started()
    await settle()
    expect(entries().filter(e => e.message.startsWith('logger.session.'))).toEqual([])
    expect(markerOnDisk()).toMatchObject({ state: 'running' })
    await logger.destroy()
  })

  it('checkpoints background and foreground, and closes on destroy', async () => {
    const { logger } = started()
    await settle()

    appState.__emit('background')
    await settle()
    expect(markerOnDisk().state).toBe('backgrounded')

    appState.__emit('inactive')
    await settle()
    expect(markerOnDisk().state).toBe('backgrounded')

    appState.__emit('active')
    await settle()
    expect(markerOnDisk().state).toBe('running')

    await logger.destroy()
    expect(markerOnDisk().state).toBe('closed')
  })

  it('keeps the last crash report id for the next start', async () => {
    const { logger } = started()
    await settle()
    logger.setLastCrashReportId('sentry-xyz')
    await settle()
    expect(markerOnDisk().lastCrashReportId).toBe('sentry-xyz')
    await logger.destroy()
  })

  it('reports a failing marker once, and logging carries on', async () => {
    mockFs.writeAsStringAsync.mockRejectedValue(new Error('disk full'))
    const { logger, entries } = started()
    await settle()
    appState.__emit('background')
    appState.__emit('active')
    await settle()

    const failures = entries().filter(e => e.message === '[Logger] session marker failed')
    expect(failures).toHaveLength(1)
    expect(failures[0].level).toBe('error')

    logger.info('still logging')
    expect(entries().some(e => e.message === 'still logging')).toBe(true)
    mockFs.writeAsStringAsync.mockReset()
    mockFs.writeAsStringAsync.mockImplementation(async (path: string, contents: string) => {
      mockFs.__mockFiles[path] = contents
    })
    await logger.destroy()
  })

  it('reports an unreadable marker at info and starts a fresh one', async () => {
    mockFs.__mockFiles[MARKER] = '{not json'
    const { logger, entries } = started()
    await settle()
    expect(entries().filter(e => e.message === 'logger.session.marker-unreadable')).toHaveLength(1)
    expect(markerOnDisk()).toMatchObject({ sessionId: logger.sessionId, state: 'running' })
    await logger.destroy()
  })

  it('touches no file when not enabled', async () => {
    previous('running')
    const logger = createLogger({ appVersion: '1.0.0', ringBuffer: true })
    await settle()
    expect(mockFs.getInfoAsync).not.toHaveBeenCalled()
    expect(mockFs.readAsStringAsync).not.toHaveBeenCalled()
    expect(mockFs.writeAsStringAsync).not.toHaveBeenCalled()
    expect(logger.getLogs().some(e => e.message.startsWith('logger.session.'))).toBe(false)
    await logger.destroy()
  })

  it('exposes the session id every entry carries', async () => {
    const logger = createLogger({ appVersion: '1.0.0', ringBuffer: true })
    logger.info('hello')
    await settle()
    expect(logger.getLogs()[0].context.sessionId).toBe(logger.sessionId)
    await logger.destroy()
  })
})
