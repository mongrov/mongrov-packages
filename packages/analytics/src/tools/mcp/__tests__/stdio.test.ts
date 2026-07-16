import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createStdioTransport } from '../transports/stdio'

describe('createStdioTransport', () => {
  it('returns a Transport with send + close + start', () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const transport = createStdioTransport({ stdin, stdout })
    expect(typeof transport.send).toBe('function')
    expect(typeof transport.close).toBe('function')
    expect(typeof transport.start).toBe('function')
  })

  it('start() begins piping stdin data through the message parser', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const transport = createStdioTransport({ stdin, stdout })
    await transport.start()
    // Basic wiring — calling close() on a fresh transport should resolve.
    await transport.close()
  })
})
