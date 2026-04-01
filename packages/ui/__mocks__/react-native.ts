import React from 'react';

function createMockComponent(name: string) {
  const component = ({ children, testID, ...props }: any) =>
    React.createElement(name, { testID, ...props }, children);
  component.displayName = name;
  return component;
}

export const View = createMockComponent('View');
export const Text = createMockComponent('Text');
export const Pressable = createMockComponent('Pressable');
export const ActivityIndicator = createMockComponent('ActivityIndicator');
export const Animated = {
  View: createMockComponent('Animated.View'),
  timing: jest.fn(() => ({ start: jest.fn((cb?: () => void) => cb?.()) })),
  loop: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })),
  Value: jest.fn(() => ({
    interpolate: jest.fn(() => 0),
    setValue: jest.fn(),
  })),
};
export const StyleSheet = {
  create: (styles: any) => styles,
};
export const Platform = {
  OS: 'ios',
  select: (options: any) => options.ios ?? options.default,
};
