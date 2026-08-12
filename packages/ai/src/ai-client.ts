import { generateText, streamText } from 'ai';
import type { AIClient, AIConfig, AILogger, Message } from './types';

// Lazy load expo/fetch with fallback
let streamFetch: typeof fetch = globalThis.fetch;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const expo = require('expo/fetch');
  streamFetch = expo.fetch;
} catch {
  // Not in Expo — streaming may not work on RN, log warning if logger provided
}

const noopLogger: AILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Tool-call rounds allowed per request.
 *
 * The AI SDK defaults `maxSteps` to 1. With tools registered, step 1 is the
 * model emitting a tool CALL — no assistant text — so `textStream` completed
 * empty and the chat looked like nothing happened: message count rose, the
 * stream opened and closed, and no error was thrown because nothing failed.
 *
 * Raising it lets the SDK run the tool, feed the result back, and take
 * another step to produce the answer. 5 covers a tool call, its result, and
 * a follow-up call or two, while still bounding a model that loops.
 */
const MAX_TOOL_STEPS = 5;

export function createAIClient(config: AIConfig): AIClient {
  const { model, logger = noopLogger, systemPrompt, tools } = config;
  let currentAbortController: AbortController | null = null;

  // Warn if expo/fetch not available
  if (streamFetch === globalThis.fetch) {
    logger.warn('expo/fetch not available, streaming may not work correctly');
  }

  async function* chat(
    messages: Message[]
  ): AsyncGenerator<string, void, unknown> {
    currentAbortController = new AbortController();

    const aiMessages = messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    if (systemPrompt) {
      aiMessages.unshift({ role: 'system' as const, content: systemPrompt });
    }

    logger.debug('Starting chat stream', { messageCount: messages.length });

    try {
      const result = streamText({
        model,
        messages: aiMessages,
        abortSignal: currentAbortController.signal,
        experimental_telemetry: { isEnabled: false },
        ...(tools ? { tools, maxSteps: MAX_TOOL_STEPS } : {}),
      });
      const { textStream } = result;

      let emitted = 0;
      for await (const chunk of textStream) {
        emitted += chunk.length;
        yield chunk;
      }

      if (emitted === 0) {
        // Not an error the SDK raises, and the symptom a user sees is simply
        // no reply — so say it out loud, with enough to tell the causes apart:
        //
        //   finishReason 'tool-calls'  → stopped on a call it never answered
        //   finishReason 'stop'        → model genuinely returned nothing
        //   finishReason 'error'       → provider rejected the request
        //   warnings non-empty         → SDK dropped an unsupported setting
        //   toolNames empty but hasTools true → `tools` was `{}`
        //
        // `hasTools` alone was not enough: an empty object is truthy, so it
        // reported true while the model had nothing to call.
        // Defensive: these are diagnostics. If a field is missing or rejects
        // — an older SDK, a partial mock — the warning should degrade, not
        // turn "no reply" into a crash.
        const settle = async <T>(v: Promise<T> | undefined, fallback: T): Promise<T> => {
          try {
            return v === undefined ? fallback : await v;
          }
          catch {
            return fallback;
          }
        };
        const [finishReason, warnings, toolCalls] = await Promise.all([
          settle(result.finishReason, 'unavailable' as string),
          settle(result.warnings, undefined),
          settle(result.toolCalls, [] as unknown[]),
        ]);
        logger.warn('Chat stream produced no text', {
          messageCount: messages.length,
          hasTools: Boolean(tools),
          toolNames: tools ? Object.keys(tools) : [],
          maxSteps: tools ? MAX_TOOL_STEPS : 1,
          finishReason,
          warnings,
          toolCallCount: Array.isArray(toolCalls) ? toolCalls.length : 0,
        });

        // A provider rejection — quota exhausted, bad key, rate limit — can
        // end the stream without `textStream` ever throwing. That surfaced as
        // a chat that sat there forever: the request failed, nothing was
        // yielded, and nothing told the user why.
        //
        // Turning it into a throw puts it on the path that already works:
        // the machine's ERROR branch, which ChatScreen renders above the
        // input as of 0.4.1.
        if (finishReason === 'error') {
          throw new Error(
            'The AI provider rejected the request. This is usually a quota, '
            + 'billing or rate-limit problem rather than a bug — check the '
            + 'provider dashboard.',
          );
        }
      }

      logger.debug('Chat stream complete', { textLength: emitted });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        logger.debug('Chat stream cancelled');
        return;
      }
      logger.error('Chat stream error', { error });
      throw error;
    } finally {
      currentAbortController = null;
    }
  }

  async function complete(prompt: string): Promise<string> {
    currentAbortController = new AbortController();

    const messages = systemPrompt
      ? [
          { role: 'system' as const, content: systemPrompt },
          { role: 'user' as const, content: prompt },
        ]
      : [{ role: 'user' as const, content: prompt }];

    logger.debug('Starting completion', { promptLength: prompt.length });

    try {
      const { text } = await generateText({
        model,
        messages,
        abortSignal: currentAbortController.signal,
        experimental_telemetry: { isEnabled: false },
        ...(tools ? { tools, maxSteps: MAX_TOOL_STEPS } : {}),
      });

      logger.debug('Completion finished', { resultLength: text.length });
      return text;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        logger.debug('Completion cancelled');
        return '';
      }
      logger.error('Completion error', { error });
      throw error;
    } finally {
      currentAbortController = null;
    }
  }

  function cancel(): void {
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
      logger.debug('Request cancelled');
    }
  }

  return {
    chat,
    complete,
    cancel,
  };
}
