import type { ReactTestInstance } from 'react-test-renderer'
/**
 * ChatScreen styling.
 *
 * Everything the component renders itself is a uniwind className resolved from
 * the consumer's semantic tokens, so it follows the app's theme and brand with
 * no configuration. Previously it painted from two hardcoded hex objects,
 * which is why a correct light/dark match still looked foreign inside a
 * branded app — iOS blue send button against an orange product.
 *
 * `theme` survives only for the colours that cannot be classNames:
 * `placeholderTextColor` (a React Native prop) and gifted-chat's `Bubble`
 * style objects.
 */
import * as React from 'react'
import { act, create } from 'react-test-renderer'

import { ChatScreen } from '../ui/ChatScreen'

const mockSystemScheme = jest.fn<'light' | 'dark' | null, []>(() => 'light')

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native')
  return { ...actual, useColorScheme: () => mockSystemScheme() }
})

jest.mock('../use-ai-chat', () => ({
  useAIChat: () => ({ messages: [], send: jest.fn(), isStreaming: false, error: null }),
}))

function render(element: React.ReactElement) {
  return create(element).root
}

function classNamesOf(root: ReactTestInstance): string[] {
  return root
    .findAll((n: ReactTestInstance) => typeof n.props?.className === 'string')
    .map((n: ReactTestInstance) => n.props.className as string)
}

describe('ChatScreen styling', () => {
  it('paints from semantic tokens, not hardcoded colours', () => {
    const all = classNamesOf(render(<ChatScreen />)).join(' ')

    // Inherits the app's surface rather than restating hex.
    expect(all).toContain('bg-background')
    expect(all).toContain('border-border')
    expect(all).toContain('text-foreground')
    expect(all).toContain('text-primary-foreground')
  })

  it('uses the brand colour for the send button once there is text', () => {
    // Disabled it is bg-muted, so the brand token only appears when sendable —
    // asserting it unconditionally would have been asserting the wrong state.
    const tree = create(<ChatScreen />)
    const input = tree.root.findAll(
      (n: ReactTestInstance) => typeof n.props?.onChangeText === 'function',
    )[0]

    act(() => {
      input.props.onChangeText('hello')
    })

    const all = classNamesOf(tree.root).join(' ')
    expect(all).toContain('bg-primary')
  })

  it('no longer takes a colorScheme prop — the dark class drives it', () => {
    // Both schemes must produce identical classNames; light/dark is resolved
    // by the consumer's `dark` class, not by branching here.
    mockSystemScheme.mockReturnValue('light')
    const light = classNamesOf(render(<ChatScreen />))
    mockSystemScheme.mockReturnValue('dark')
    const dark = classNamesOf(render(<ChatScreen />))

    expect(dark).toEqual(light)
  })

  it('still follows the scheme for placeholder, which cannot be a className', () => {
    const placeholderOf = (el: React.ReactElement) =>
      render(el).findAll((n: ReactTestInstance) => n.props?.placeholderTextColor)[0]?.props.placeholderTextColor

    mockSystemScheme.mockReturnValue('light')
    const light = placeholderOf(<ChatScreen />)
    mockSystemScheme.mockReturnValue('dark')
    const dark = placeholderOf(<ChatScreen />)

    expect(light).toBeDefined()
    expect(dark).not.toBe(light)
  })

  it('lets theme override the raw-colour values', () => {
    mockSystemScheme.mockReturnValue('light')
    const root = render(<ChatScreen theme={{ placeholder: '#123456' }} />)

    const input = root.findAll((n: ReactTestInstance) => n.props?.placeholderTextColor)[0]
    expect(input.props.placeholderTextColor).toBe('#123456')
  })
})
