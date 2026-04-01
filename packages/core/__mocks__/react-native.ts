import React from 'react';

function createMockComponent(name: string) {
  const component = ({ children, testID, onPress, ...props }: any) =>
    React.createElement(name, { testID, onPress, ...props }, children);
  component.displayName = name;
  return component;
}

export const View = createMockComponent('View');
export const Text = createMockComponent('Text');
export const Pressable = createMockComponent('Pressable');
export const FlatList = ({ data, renderItem, keyExtractor, ...props }: any) =>
  React.createElement('FlatList', { data, keyExtractor, ...props }, null);
export const Share = {
  share: jest.fn().mockResolvedValue({ action: 'shared' }),
};
export const Platform = {
  OS: 'ios',
  select: (options: any) => options.ios ?? options.default,
};
