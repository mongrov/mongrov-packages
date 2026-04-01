import React from 'react';
import { create } from 'react-test-renderer';
import { StreamingText } from '../ui/StreamingText';
import { QuickReplyBar } from '../ui/QuickReplyBar';
import { ChatEmptyState } from '../ui/ChatEmptyState';

describe('StreamingText', () => {
  it('renders text content', () => {
    const tree = create(<StreamingText text="Hello world" />);
    const texts = tree.root.findAllByType('Text' as any);
    expect(texts.some((t) => t.children.includes('Hello world'))).toBe(true);
  });

  it('renders cursor when streaming', () => {
    const tree = create(<StreamingText text="Hello" isStreaming={true} />);
    const animatedTexts = tree.root.findAllByType('Animated.Text' as any);
    expect(animatedTexts.length).toBeGreaterThan(0);
  });

  it('does not render cursor when not streaming', () => {
    const tree = create(<StreamingText text="Hello" isStreaming={false} />);
    const animatedTexts = tree.root.findAllByType('Animated.Text' as any);
    expect(animatedTexts.length).toBe(0);
  });

  it('uses custom cursor char', () => {
    const tree = create(
      <StreamingText text="Hello" isStreaming={true} cursorChar="|" />
    );
    const animatedTexts = tree.root.findAllByType('Animated.Text' as any);
    expect(animatedTexts.some((t) => t.children.includes('|'))).toBe(true);
  });

  it('accepts testID', () => {
    const tree = create(<StreamingText text="Hello" testID="streaming" />);
    expect(tree.root.findByProps({ testID: 'streaming' })).toBeTruthy();
  });
});

describe('QuickReplyBar', () => {
  it('renders reply buttons', () => {
    const onSelect = jest.fn();
    const tree = create(
      <QuickReplyBar
        replies={['Hello', 'Help', 'Info']}
        onSelect={onSelect}
        testID="quick"
      />
    );
    const texts = tree.root.findAllByType('Text' as any);
    expect(texts.some((t) => t.children.includes('Hello'))).toBe(true);
    expect(texts.some((t) => t.children.includes('Help'))).toBe(true);
    expect(texts.some((t) => t.children.includes('Info'))).toBe(true);
  });

  it('calls onSelect when reply is pressed', () => {
    const onSelect = jest.fn();
    const tree = create(
      <QuickReplyBar
        replies={['Hello', 'Help']}
        onSelect={onSelect}
        testID="quick"
      />
    );
    const button = tree.root.findByProps({ testID: 'quick-0' });
    button.props.onPress();
    expect(onSelect).toHaveBeenCalledWith('Hello');
  });

  it('returns null for empty replies', () => {
    const onSelect = jest.fn();
    const tree = create(<QuickReplyBar replies={[]} onSelect={onSelect} />);
    expect(tree.toJSON()).toBeNull();
  });

  it('returns null for undefined replies', () => {
    const onSelect = jest.fn();
    const tree = create(
      <QuickReplyBar replies={undefined as any} onSelect={onSelect} />
    );
    expect(tree.toJSON()).toBeNull();
  });
});

describe('ChatEmptyState', () => {
  it('renders default title and subtitle', () => {
    const tree = create(<ChatEmptyState />);
    const texts = tree.root.findAllByType('Text' as any);
    expect(
      texts.some((t) => t.children.includes('Start a conversation'))
    ).toBe(true);
    expect(
      texts.some((t) =>
        t.children.includes('Send a message to begin chatting with AI')
      )
    ).toBe(true);
  });

  it('renders custom title and subtitle', () => {
    const tree = create(
      <ChatEmptyState title="Welcome" subtitle="Ask me anything" />
    );
    const texts = tree.root.findAllByType('Text' as any);
    expect(texts.some((t) => t.children.includes('Welcome'))).toBe(true);
    expect(texts.some((t) => t.children.includes('Ask me anything'))).toBe(
      true
    );
  });

  it('accepts testID', () => {
    const tree = create(<ChatEmptyState testID="empty" />);
    expect(tree.root.findByProps({ testID: 'empty' })).toBeTruthy();
  });
});
