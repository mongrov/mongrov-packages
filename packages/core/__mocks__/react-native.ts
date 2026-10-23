import * as React from 'react'

function createMockComponent(name: string) {
  const component = ({ children, testID, onPress, ...props }: any) =>
    React.createElement(name, { testID, onPress, ...props }, children)
  component.displayName = name
  return component
}

export const View = createMockComponent('View')
export const Text = createMockComponent('Text')
export const Pressable = createMockComponent('Pressable')
export function FlatList({ data, renderItem, keyExtractor, ...props }: any) {
  return React.createElement('FlatList', { data, keyExtractor, ...props }, null)
}
export const Share = {
  share: jest.fn().mockResolvedValue({ action: 'shared' }),
}
export const Platform = {
  OS: 'ios',
  select: (options: any) => options.ios ?? options.default,
}

type AppStateListener = (state: string) => void
const appStateListeners = new Set<AppStateListener>()
export const AppState = {
  currentState: 'active',
  addEventListener: jest.fn((_event: string, listener: AppStateListener) => {
    appStateListeners.add(listener)
    return { remove: () => appStateListeners.delete(listener) }
  }),
  // Test seam: deliver an AppState change to every listener.
  __emit(state: string) {
    for (const listener of appStateListeners) listener(state)
  },
}
