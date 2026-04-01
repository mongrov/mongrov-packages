import React from 'react';
import { Pressable, Text, View } from 'react-native';
import type { EmptyStateProps } from './types';

export function EmptyState({ icon, title, subtitle, action, testID }: EmptyStateProps) {
  return (
    <View className="flex-1 items-center justify-center p-8" testID={testID}>
      {icon && <View className="mb-4">{icon}</View>}
      <Text className="text-lg font-semibold text-foreground text-center">{title}</Text>
      {subtitle && (
        <Text className="mt-2 text-sm text-muted-foreground text-center">{subtitle}</Text>
      )}
      {action && (
        <Pressable
          className="mt-6 rounded-lg bg-primary px-6 py-3"
          onPress={action.onPress}
          testID={testID ? `${testID}-action` : undefined}
        >
          <Text className="text-sm font-medium text-primary-foreground">{action.label}</Text>
        </Pressable>
      )}
    </View>
  );
}
