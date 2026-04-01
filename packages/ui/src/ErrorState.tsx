import React from 'react';
import { Pressable, Text, View } from 'react-native';
import type { ErrorStateProps } from './types';

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
  retryLabel = 'Try again',
  testID,
}: ErrorStateProps) {
  return (
    <View className="flex-1 items-center justify-center p-8" testID={testID}>
      <Text className="text-lg font-semibold text-destructive text-center">{title}</Text>
      <Text className="mt-2 text-sm text-muted-foreground text-center">{message}</Text>
      {onRetry && (
        <Pressable
          className="mt-6 rounded-lg bg-destructive px-6 py-3"
          onPress={onRetry}
          testID={testID ? `${testID}-retry` : undefined}
        >
          <Text className="text-sm font-medium text-destructive-foreground">{retryLabel}</Text>
        </Pressable>
      )}
    </View>
  );
}
