import { createActor } from 'xstate';
import { completionMachine } from '../machines/completion-machine';

describe('completionMachine', () => {
  it('starts in idle state', () => {
    const actor = createActor(completionMachine);
    actor.start();
    expect(actor.getSnapshot().value).toBe('idle');
    expect(actor.getSnapshot().context.result).toBeNull();
    actor.stop();
  });

  it('transitions to loading on GENERATE event', () => {
    const actor = createActor(completionMachine);
    actor.start();
    actor.send({ type: 'GENERATE', prompt: 'Hello' });
    expect(actor.getSnapshot().value).toBe('loading');
    actor.stop();
  });

  it('does not transition on empty prompt', () => {
    const actor = createActor(completionMachine);
    actor.start();
    actor.send({ type: 'GENERATE', prompt: '   ' });
    expect(actor.getSnapshot().value).toBe('idle');
    actor.stop();
  });

  it('transitions to idle with result on COMPLETE', () => {
    const actor = createActor(completionMachine);
    actor.start();
    actor.send({ type: 'GENERATE', prompt: 'Hello' });
    actor.send({ type: 'COMPLETE', result: 'World' });
    expect(actor.getSnapshot().value).toBe('idle');
    expect(actor.getSnapshot().context.result).toBe('World');
    actor.stop();
  });

  it('transitions to idle on CANCEL', () => {
    const actor = createActor(completionMachine);
    actor.start();
    actor.send({ type: 'GENERATE', prompt: 'Hello' });
    actor.send({ type: 'CANCEL' });
    expect(actor.getSnapshot().value).toBe('idle');
    actor.stop();
  });

  it('transitions to error on ERROR event', () => {
    const actor = createActor(completionMachine);
    actor.start();
    actor.send({ type: 'GENERATE', prompt: 'Hello' });
    actor.send({ type: 'ERROR', error: new Error('API error') });
    expect(actor.getSnapshot().value).toBe('error');
    expect(actor.getSnapshot().context.error?.message).toBe('API error');
    actor.stop();
  });

  it('can generate from error state', () => {
    const actor = createActor(completionMachine);
    actor.start();
    actor.send({ type: 'GENERATE', prompt: 'Hello' });
    actor.send({ type: 'ERROR', error: new Error('Error') });
    actor.send({ type: 'GENERATE', prompt: 'Retry' });
    expect(actor.getSnapshot().value).toBe('loading');
    expect(actor.getSnapshot().context.error).toBeNull();
    actor.stop();
  });

  it('clears result on new generate', () => {
    const actor = createActor(completionMachine);
    actor.start();
    actor.send({ type: 'GENERATE', prompt: 'First' });
    actor.send({ type: 'COMPLETE', result: 'First result' });
    actor.send({ type: 'GENERATE', prompt: 'Second' });
    expect(actor.getSnapshot().context.result).toBeNull();
    actor.stop();
  });

  it('creates abort controller on GENERATE', () => {
    const actor = createActor(completionMachine);
    actor.start();
    actor.send({ type: 'GENERATE', prompt: 'Hello' });
    expect(actor.getSnapshot().context.abortController).toBeInstanceOf(
      AbortController
    );
    actor.stop();
  });

  it('clears abort controller on complete', () => {
    const actor = createActor(completionMachine);
    actor.start();
    actor.send({ type: 'GENERATE', prompt: 'Hello' });
    actor.send({ type: 'COMPLETE', result: 'Done' });
    expect(actor.getSnapshot().context.abortController).toBeNull();
    actor.stop();
  });
});
