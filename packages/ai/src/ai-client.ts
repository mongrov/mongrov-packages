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

export function createAIClient(config: AIConfig): AIClient {
  const { model, logger = noopLogger, systemPrompt } = config;
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
      const { textStream } = streamText({
        model,
        messages: aiMessages,
        abortSignal: currentAbortController.signal,
        experimental_telemetry: { isEnabled: false },
      });

      for await (const chunk of textStream) {
        yield chunk;
      }

      logger.debug('Chat stream complete');
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
