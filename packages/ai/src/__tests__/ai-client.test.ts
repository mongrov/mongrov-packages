/**
 * Tests for `createAIClient` — focused on `config.tools` threading
 * to both `streamText` (chat) and `generateText` (complete).
 *
 * `ai` is fully mocked so we assert on call args rather than
 * exercising the real SDK.
 */

import type { CoreTool, LanguageModelV1 } from 'ai'
import type { AIConfig, Message } from '../types'
import { createAIClient } from '../ai-client'

const streamTextMock = jest.fn()
const generateTextMock = jest.fn()

jest.mock('ai', () => ({
  streamText: (opts: unknown) => streamTextMock(opts),
  generateText: (opts: unknown) => generateTextMock(opts),
}))

// Trivial fake model — the mocked SDK never reads its internals.
const fakeModel = {} as LanguageModelV1

// Trivial fake tool — same shape works for both v4 CoreTool signature
// and our assertions (we only check identity / presence).
const fakeTool = {
  description: 'noop',
  parameters: { type: 'object', properties: {} },
  execute: async () => 'ok',
} as unknown as CoreTool

function makeAsyncStream(chunks: string[]): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        async next() {
          if (i < chunks.length) {
            return { value: chunks[i++], done: false }
          }
          return { value: undefined as unknown as string, done: true }
        },
      }
    },
  }
}

describe('createAIClient tools threading', () => {
  beforeEach(() => {
    streamTextMock.mockReset()
    generateTextMock.mockReset()
    streamTextMock.mockReturnValue({ textStream: makeAsyncStream(['hi']) })
    generateTextMock.mockResolvedValue({ text: 'done' })
  })

  const userMessages: Message[] = [
    { id: '1', role: 'user', content: 'hello' },
  ]

  it('passes tools through to streamText when provided', async () => {
    const config: AIConfig = {
      model: fakeModel,
      tools: { foo: fakeTool },
    }
    const client = createAIClient(config)

    const chunks: string[] = []
    for await (const c of client.chat(userMessages)) {
      chunks.push(c)
    }

    expect(streamTextMock).toHaveBeenCalledTimes(1)
    const args = streamTextMock.mock.calls[0][0] as Record<string, unknown>
    expect(args.tools).toEqual({ foo: fakeTool })
    expect(chunks).toEqual(['hi'])
  })

  it('omits tools key from streamText when config.tools is undefined', async () => {
    const config: AIConfig = { model: fakeModel }
    const client = createAIClient(config)

    for await (const _ of client.chat(userMessages)) {
      // drain
    }

    expect(streamTextMock).toHaveBeenCalledTimes(1)
    const args = streamTextMock.mock.calls[0][0] as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(args, 'tools')).toBe(false)
  })

  it('passes tools through to generateText when provided', async () => {
    const config: AIConfig = {
      model: fakeModel,
      tools: { foo: fakeTool },
    }
    const client = createAIClient(config)

    await client.complete('prompt')

    expect(generateTextMock).toHaveBeenCalledTimes(1)
    const args = generateTextMock.mock.calls[0][0] as Record<string, unknown>
    expect(args.tools).toEqual({ foo: fakeTool })
  })

  it('omits tools key from generateText when config.tools is undefined', async () => {
    const config: AIConfig = { model: fakeModel }
    const client = createAIClient(config)

    await client.complete('prompt')

    expect(generateTextMock).toHaveBeenCalledTimes(1)
    const args = generateTextMock.mock.calls[0][0] as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(args, 'tools')).toBe(false)
  })
})
