/**
 * `theme` override.
 *
 * The built-in palette is iOS-generic — #007AFF send button, grey bubbles.
 * zivaone_app's primary is orange (#FF7B1A), so an otherwise correct
 * light/dark match still read as a foreign component inside the app.
 */
const mockSystemScheme = jest.fn<'light' | 'dark' | null, []>(() => 'light');

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return { ...actual, useColorScheme: () => mockSystemScheme() };
});

jest.mock('../use-ai-chat', () => ({
  useAIChat: () => ({ messages: [], send: jest.fn(), isStreaming: false, error: null }),
}));

import React from 'react';
import { create } from 'react-test-renderer';

import { ChatScreen } from '../ui/ChatScreen';

function backgroundOf(element: React.ReactElement): unknown {
  const tree = create(element);
  const root = tree.root.findAllByType('View' as never)[0];
  return (root.props.style as Record<string, unknown> | undefined)?.backgroundColor;
}

describe('ChatScreen theme override', () => {
  it('merges over the resolved base — partial overrides are allowed', () => {
    mockSystemScheme.mockReturnValue('light');
    // Only `background` named; everything else must still come from light.
    expect(backgroundOf(<ChatScreen theme={{ background: '#FF7B1A' }} />)).toBe('#FF7B1A');
  });

  it('leaves untouched tokens at their base value', () => {
    mockSystemScheme.mockReturnValue('dark');
    // Overriding an unrelated token must not disturb the background.
    expect(backgroundOf(<ChatScreen theme={{ sendButton: '#FF7B1A' }} />)).toBe('#000000');
  });

  it('composes with colorScheme', () => {
    mockSystemScheme.mockReturnValue('light');
    expect(backgroundOf(<ChatScreen colorScheme="dark" />)).toBe('#000000');
    expect(
      backgroundOf(<ChatScreen colorScheme="dark" theme={{ background: '#111111' }} />),
    ).toBe('#111111');
  });
});
