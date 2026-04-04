import React from 'react';

// Map React Native testID to data-testid for jsdom
function createMockComponent(htmlElement: string, displayName: string) {
  const component = ({ children, testID, className, ...props }: any) =>
    React.createElement(
      htmlElement,
      { 'data-testid': testID, className, ...props },
      children
    );
  component.displayName = displayName;
  return component;
}

// Special mock for Pressable that maps onPress to onClick and accessibilityLabel to aria-label
function createPressableMock() {
  const component = ({ children, testID, className, onPress, accessibilityLabel, ...props }: any) =>
    React.createElement(
      'button',
      { 'data-testid': testID, className, onClick: onPress, 'aria-label': accessibilityLabel, ...props },
      children
    );
  component.displayName = 'Pressable';
  return component;
}

export const View = createMockComponent('div', 'View');
export const Text = createMockComponent('span', 'Text');
export const Pressable = createPressableMock();
export const ActivityIndicator = createMockComponent('span', 'ActivityIndicator');
export const Animated = {
  View: createMockComponent('div', 'Animated.View'),
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
