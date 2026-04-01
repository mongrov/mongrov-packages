import React from 'react';
import { Text, View } from 'react-native';
import type { SyncIndicatorProps, SyncStatus } from './types';

const statusConfig: Record<SyncStatus, { dot: string; label: string }> = {
  idle: { dot: 'bg-success', label: 'Synced' },
  syncing: { dot: 'bg-warning', label: 'Syncing...' },
  error: { dot: 'bg-destructive', label: 'Sync error' },
};

export function SyncIndicator({ status, label, testID }: SyncIndicatorProps) {
  const config = statusConfig[status];

  return (
    <View className="flex-row items-center gap-2" testID={testID}>
      <View className={`h-2 w-2 rounded-full ${config.dot}`} />
      <Text className="text-xs text-muted-foreground">{label ?? config.label}</Text>
    </View>
  );
}
