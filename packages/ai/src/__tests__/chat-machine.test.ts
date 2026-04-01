import { createActor } from 'xstate';
import { chatMachine } from '../machines/chat-machine';

describe('chatMachine', () => {
  it('starts in idle state', () => {
    const actor = createActor(chatMachine);
    actor.start();
    expect(actor.getSnapshot().value).toBe('idle');
    expect(actor.getSnapshot().context.messages).toEqual([]);
    actor.stop();
  });

  it('transitions to sending on SEND event', () => {
    const actor = createActor(chatMachine);
    actor.start();
    actor.send({ type: 'SEND', content: 'Hello' });
    expect(actor.getSnapshot().value).toBe('sending');
    expect(actor.getSnapshot().context.messages).toHaveLength(2); // user + assistant placeholder
    actor.stop();
  });

  it('does not transition on empty content', () => {
    const actor = createActor(chatMachine);
    actor.start();
    actor.send({ type: 'SEND', content: '   ' });
    expect(actor.getSnapshot().value).toBe('idle');
    expect(actor.getSnapshot().context.messages).toHaveLength(0);
    actor.stop();
  });

  it('appends stream chunks during sending', () => {
    const actor = createActor(chatMachine);
    actor.start();
    actor.send({ type: 'SEND', content: 'Hello' });
    actor.send({ type: 'STREAM_CHUNK', chunk: 'Hi ' });
    actor.send({ type: 'STREAM_CHUNK', chunk: 'there!' });

    const messages = actor.getSnapshot().context.messages;
    const lastMessage = messages[messages.length - 1];
    expect(lastMessage.content).toBe('Hi there!');
    actor.stop();
  });

  it('transitions to idle on STREAM_COMPLETE', () => {
    const actor = createActor(chatMachine);
    actor.start();
    actor.send({ type: 'SEND', content: 'Hello' });
    actor.send({ type: 'STREAM_CHUNK', chunk: 'Response' });
    actor.send({ type: 'STREAM_COMPLETE' });
    expect(actor.getSnapshot().value).toBe('idle');
    actor.stop();
  });

  it('transitions to idle on CANCEL', () => {
    const actor = createActor(chatMachine);
    actor.start();
    actor.send({ type: 'SEND', content: 'Hello' });
    actor.send({ type: 'CANCEL' });
    expect(actor.getSnapshot().value).toBe('idle');
    actor.stop();
  });

  it('transitions to error on ERROR event', () => {
    const actor = createActor(chatMachine);
    actor.start();
    actor.send({ type: 'SEND', content: 'Hello' });
    actor.send({ type: 'ERROR', error: new Error('Network error') });
    expect(actor.getSnapshot().value).toBe('error');
    expect(actor.getSnapshot().context.error?.message).toBe('Network error');
    actor.stop();
  });

  it('can send from error state', () => {
    const actor = createActor(chatMachine);
    actor.start();
    actor.send({ type: 'SEND', content: 'Hello' });
    actor.send({ type: 'ERROR', error: new Error('Error') });
    actor.send({ type: 'SEND', content: 'Retry' });
    expect(actor.getSnapshot().value).toBe('sending');
    actor.stop();
  });

  it('sets messages with SET_MESSAGES', () => {
    const actor = createActor(chatMachine);
    actor.start();
    actor.send({
      type: 'SET_MESSAGES',
      messages: [
        { id: '1', role: 'user', content: 'Test' },
        { id: '2', role: 'assistant', content: 'Response' },
      ],
    });
    expect(actor.getSnapshot().context.messages).toHaveLength(2);
    actor.stop();
  });

  it('clears messages with CLEAR_MESSAGES', () => {
    const actor = createActor(chatMachine);
    actor.start();
    actor.send({ type: 'SEND', content: 'Hello' });
    actor.send({ type: 'STREAM_COMPLETE' });
    actor.send({ type: 'CLEAR_MESSAGES' });
    expect(actor.getSnapshot().context.messages).toHaveLength(0);
    expect(actor.getSnapshot().value).toBe('idle');
    actor.stop();
  });

  it('creates abort controller on SEND', () => {
    const actor = createActor(chatMachine);
    actor.start();
    actor.send({ type: 'SEND', content: 'Hello' });
    expect(actor.getSnapshot().context.abortController).toBeInstanceOf(
      AbortController
    );
    actor.stop();
  });

  it('clears abort controller on complete', () => {
    const actor = createActor(chatMachine);
    actor.start();
    actor.send({ type: 'SEND', content: 'Hello' });
    actor.send({ type: 'STREAM_COMPLETE' });
    expect(actor.getSnapshot().context.abortController).toBeNull();
    actor.stop();
  });
});
