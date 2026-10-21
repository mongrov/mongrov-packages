/**
 * What the connection machine and the base adapter report to an injected
 * logger. A failed `connect()` used to log nothing: `logError` only matched
 * CONNECTION_ERROR, and an invoke rejection is a different event.
 */

import type { CollabLogger } from '../types'
import { createActor, waitFor } from 'xstate'
import { collabMachine } from '../machine'
import { MockAdapter } from './mock-adapter'

function fakeLogger(): jest.Mocked<CollabLogger> {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}

const credentials = { serverUrl: 'wss://example.test', userId: 'u', token: 'secret-token' }

describe('collab logging', () => {
  it('logs a failed connect at error, without credentials', async () => {
    const logger = fakeLogger()
    const adapter = new MockAdapter()
    adapter.shouldFailConnect = true
    const actor = createActor(collabMachine, { input: { adapter, logger } })
    actor.start()
    actor.send({ type: 'CONNECT', credentials })
    await waitFor(actor, s => s.value === 'error')

    expect(logger.info).toHaveBeenCalledWith('[Collab] connecting', { adapter: 'mock' })
    expect(logger.error).toHaveBeenCalledWith('[Collab] connect failed', expect.objectContaining({
      adapter: 'mock',
      error: 'Error: Mock connection failed',
    }))
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret-token')
    actor.stop()
  })

  it('logs connected and disconnected at info', async () => {
    const logger = fakeLogger()
    const adapter = new MockAdapter()
    const actor = createActor(collabMachine, { input: { adapter, logger } })
    actor.start()
    actor.send({ type: 'CONNECT', credentials })
    await waitFor(actor, s => s.value === 'connected')
    actor.send({ type: 'DISCONNECT' })
    await waitFor(actor, s => s.value === 'disconnected')

    expect(logger.info).toHaveBeenCalledWith('[Collab] connected', { adapter: 'mock', afterReconnectAttempts: 0 })
    expect(logger.info).toHaveBeenCalledWith('[Collab] disconnected', { adapter: 'mock' })
    expect(logger.error).not.toHaveBeenCalled()
    actor.stop()
  })

  it('reports a throwing event handler through the adapter logger', () => {
    const logger = fakeLogger()
    const adapter = new MockAdapter()
    adapter.setLogger(logger)
    const next = jest.fn()
    adapter.on('connection:connected', () => {
      throw new Error('boom')
    })
    adapter.on('connection:connected', next)
    adapter.emit('connection:connected', undefined)

    expect(next).toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('[Collab] event handler threw', {
      adapter: 'mock',
      event: 'connection:connected',
      error: 'Error: boom',
    })
  })
})
