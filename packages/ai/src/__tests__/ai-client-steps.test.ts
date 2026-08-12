/**
 * `maxSteps` and the empty-stream warning.
 *
 * The AI SDK defaults `maxSteps` to 1. With tools registered, step 1 is the
 * model emitting a tool CALL and no assistant text — so `textStream`
 * completed empty and the chat looked like nothing happened: message count
 * rose, the stream opened and closed, and nothing threw. These pin the two
 * things that fix and expose that.
 */

const streamTextMock = jest.fn();
const generateTextMock = jest.fn();

jest.mock('ai', () => ({
  streamText: (opts: unknown) => streamTextMock(opts),
  generateText: (opts: unknown) => generateTextMock(opts),
}));

import type { CoreTool, LanguageModelV1 } from 'ai';

import { createAIClient } from '../ai-client';
import type { AIConfig, Message } from '../types';

const fakeModel = {} as LanguageModelV1;
const fakeTool = {
  description: 'noop',
  parameters: { type: 'object', properties: {} },
  execute: async () => 'ok',
} as unknown as CoreTool;

function stream(chunks: string[]): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

const MESSAGES: Message[] = [
  { id: '1', role: 'user', content: 'How was my sleep?', createdAt: new Date(0) },
];

function logger() {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

async function drain(it: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const c of it) out += c;
  return out;
}

beforeEach(() => {
  streamTextMock.mockReset();
  generateTextMock.mockReset();
});

describe('maxSteps', () => {
  it('is sent when tools are registered — otherwise a tool call ends the turn', async () => {
    streamTextMock.mockReturnValue({ textStream: stream(['hi']) });
    const log = logger();
    const client = createAIClient({
      model: fakeModel,
      logger: log,
      tools: { getSleep: fakeTool },
    } as unknown as AIConfig);

    await drain(client.chat(MESSAGES));

    const opts = streamTextMock.mock.calls[0][0];
    expect(opts.maxSteps).toBeGreaterThan(1);
    expect(opts.tools).toBeDefined();
  });

  it('is omitted when there are no tools — nothing to step through', async () => {
    streamTextMock.mockReturnValue({ textStream: stream(['hi']) });
    const client = createAIClient({ model: fakeModel, logger: logger() } as unknown as AIConfig);

    await drain(client.chat(MESSAGES));

    const opts = streamTextMock.mock.calls[0][0];
    expect(opts.maxSteps).toBeUndefined();
    expect(opts.tools).toBeUndefined();
  });

  it('reaches generateText too', async () => {
    generateTextMock.mockResolvedValue({ text: 'done' });
    const client = createAIClient({
      model: fakeModel,
      logger: logger(),
      tools: { getSleep: fakeTool },
    } as unknown as AIConfig);

    await client.complete('hello');

    expect(generateTextMock.mock.calls[0][0].maxSteps).toBeGreaterThan(1);
  });
});

describe('empty stream is not silent', () => {
  it('warns when the model produces no text', async () => {
    streamTextMock.mockReturnValue({ textStream: stream([]) });
    const log = logger();
    const client = createAIClient({
      model: fakeModel,
      logger: log,
      tools: { getSleep: fakeTool },
    } as unknown as AIConfig);

    expect(await drain(client.chat(MESSAGES))).toBe('');
    expect(log.warn).toHaveBeenCalledWith(
      'Chat stream produced no text',
      expect.objectContaining({ hasTools: true }),
    );
  });

  it('stays quiet when text did arrive', async () => {
    streamTextMock.mockReturnValue({ textStream: stream(['some', ' text']) });
    const log = logger();
    const client = createAIClient({ model: fakeModel, logger: log } as unknown as AIConfig);

    expect(await drain(client.chat(MESSAGES))).toBe('some text');
    // Not `not.toHaveBeenCalled()` — an unrelated "expo/fetch not available"
    // warning fires under Jest, and asserting on total call count would make
    // this test about that instead.
    expect(log.warn).not.toHaveBeenCalledWith(
      'Chat stream produced no text',
      expect.anything(),
    );
  });
});
