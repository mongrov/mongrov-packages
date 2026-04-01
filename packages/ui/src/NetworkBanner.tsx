import React from 'react';
import { Text, View } from 'react-native';
import type { NetworkBannerProps } from './types';

export function NetworkBanner({
  isConnected,
  message = 'No internet connection',
  testID,
}: NetworkBannerProps) {
  if (isConnected) return null;

  return (
    <View className="bg-destructive px-4 py-2" testID={testID}>
      <Text className="text-center text-sm font-medium text-destructive-foreground">
        {message}
      </Text>
    </View>
  );
}
