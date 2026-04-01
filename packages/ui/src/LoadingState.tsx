import React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import type { LoadingStateProps } from './types';

export function LoadingState({ message, size = 'large', testID }: LoadingStateProps) {
  return (
    <View className="flex-1 items-center justify-center p-8" testID={testID}>
      <ActivityIndicator size={size} />
      {message && (
        <Text className="mt-4 text-sm text-muted-foreground text-center">{message}</Text>
      )}
    </View>
  );
}
