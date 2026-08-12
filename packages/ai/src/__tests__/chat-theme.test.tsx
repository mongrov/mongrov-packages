/**
 * `colorScheme` override.
 *
 * ChatScreen read react-native's `useColorScheme`, which is the SYSTEM
 * appearance. zivaone_app keeps its own theme in a Zustand + MMKV store, so a
 * user on dark-in-app with a light OS got a light chat inside a dark app.
 */
const mockSystemScheme = jest.fn<'light' | 'dark' | null, []>(() => 'light');

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return { ...actual, useColorScheme: () => mockSystemScheme() };
});

jest.mock('../use-ai-chat', () => ({
  useAIChat: () => ({
    messages: [],
    send: jest.fn(),
    isStreaming: false,
    error: null,
  }),
}));

import React from 'react';
import { create } from 'react-test-renderer';

import { ChatScreen } from '../ui/ChatScreen';

/** Background colour of the outermost View — light #ffffff, dark #000000. */
function background(element: React.ReactElement): unknown {
  const tree = create(element);
  const root = tree.root.findAllByType('View' as never)[0];
  const style = root.props.style as Record<string, unknown> | undefined;
  return style?.backgroundColor;
}

describe('ChatScreen colorScheme', () => {
  it('follows the OS when no override is given', () => {
    mockSystemScheme.mockReturnValue('dark');
    expect(background(<ChatScreen />)).toBe('#000000');

    mockSystemScheme.mockReturnValue('light');
    expect(background(<ChatScreen />)).toBe('#ffffff');
  });

  it('lets the override win over the OS', () => {
    // The case that was broken: app says dark, OS says light.
    mockSystemScheme.mockReturnValue('light');
    expect(background(<ChatScreen colorScheme="dark" />)).toBe('#000000');

    mockSystemScheme.mockReturnValue('dark');
    expect(background(<ChatScreen colorScheme="light" />)).toBe('#ffffff');
  });
});
