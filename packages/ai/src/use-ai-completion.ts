import { useCallback, useMemo } from 'react';
import { useMachine } from '@xstate/react';
import { completionMachine } from './machines/completion-machine';
import { useAIClient } from './ai-provider';
import type { UseAICompletionReturn } from './types';

export function useAICompletion(): UseAICompletionReturn {
  const client = useAIClient();
  const [state, send] = useMachine(completionMachine);

  const generate = useCallback(
    async (prompt: string): Promise<string> => {
      if (!prompt.trim()) return '';

      send({ type: 'GENERATE', prompt });

      try {
        const result = await client.complete(prompt);
        send({ type: 'COMPLETE', result });
        return result;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        send({ type: 'ERROR', error: err });
        throw err;
      }
    },
    [client, send]
  );

  const cancel = useCallback(() => {
    client.cancel();
    send({ type: 'CANCEL' });
  }, [client, send]);

  const result = useMemo<UseAICompletionReturn>(
    () => ({
      result: state.context.result,
      generate,
      isLoading: state.matches('loading'),
      cancel,
      error: state.context.error,
    }),
    [state.context.result, state.context.error, state.value, generate, cancel]
  );

  return result;
}
