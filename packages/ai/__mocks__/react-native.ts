import React from 'react';

const mockAnimatedValue = {
  setValue: jest.fn(),
  setOffset: jest.fn(),
  flattenOffset: jest.fn(),
  extractOffset: jest.fn(),
  addListener: jest.fn(() => '1'),
  removeListener: jest.fn(),
  removeAllListeners: jest.fn(),
  stopAnimation: jest.fn((callback) => callback && callback(0)),
  resetAnimation: jest.fn((callback) => callback && callback(0)),
  interpolate: jest.fn(() => mockAnimatedValue),
  __getValue: jest.fn(() => 0),
};

const mockAnimatedTiming = {
  start: jest.fn((callback) => callback && callback({ finished: true })),
  stop: jest.fn(),
  reset: jest.fn(),
};

export const View = 'View';
export const Text = 'Text';
export const TouchableOpacity = 'TouchableOpacity';
export const Pressable = 'Pressable';
export const ScrollView = 'ScrollView';
export const StyleSheet = {
  create: <T extends Record<string, unknown>>(styles: T): T => styles,
  flatten: jest.fn((style) => style),
};

export const Animated = {
  View: 'Animated.View',
  Text: 'Animated.Text',
  Image: 'Animated.Image',
  Value: jest.fn(() => ({ ...mockAnimatedValue })),
  ValueXY: jest.fn(() => ({
    ...mockAnimatedValue,
    x: { ...mockAnimatedValue },
    y: { ...mockAnimatedValue },
    getLayout: jest.fn(() => ({ left: 0, top: 0 })),
    getTranslateTransform: jest.fn(() => [{ translateX: 0 }, { translateY: 0 }]),
  })),
  timing: jest.fn(() => mockAnimatedTiming),
  spring: jest.fn(() => mockAnimatedTiming),
  decay: jest.fn(() => mockAnimatedTiming),
  sequence: jest.fn(() => mockAnimatedTiming),
  parallel: jest.fn(() => mockAnimatedTiming),
  stagger: jest.fn(() => mockAnimatedTiming),
  loop: jest.fn(() => mockAnimatedTiming),
  event: jest.fn(() => jest.fn()),
  createAnimatedComponent: jest.fn((component) => component),
  delay: jest.fn(() => mockAnimatedTiming),
};

export const Platform = {
  OS: 'ios',
  select: jest.fn((obj: Record<string, unknown>) => obj.ios ?? obj.default),
  Version: 14,
};

export const Dimensions = {
  get: jest.fn(() => ({ width: 375, height: 812, scale: 2, fontScale: 1 })),
  addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  removeEventListener: jest.fn(),
};

export const useColorScheme = jest.fn(() => 'light');
export const useWindowDimensions = jest.fn(() => ({
  width: 375,
  height: 812,
  scale: 2,
  fontScale: 1,
}));

export default {
  View,
  Text,
  TouchableOpacity,
  Pressable,
  ScrollView,
  StyleSheet,
  Animated,
  Platform,
  Dimensions,
  useColorScheme,
  useWindowDimensions,
};
