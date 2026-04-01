import React from 'react';
import { Text, View } from 'react-native';
import type { LogEntryRowProps } from './types';

const LEVEL_COLORS: Record<string, string> = {
  debug: 'text-muted-foreground',
  info: 'text-info',
  warn: 'text-warning',
  error: 'text-destructive',
};

const LEVEL_BG: Record<string, string> = {
  debug: 'bg-muted',
  info: 'bg-info/10',
  warn: 'bg-warning/10',
  error: 'bg-destructive/10',
};

export function LogEntryRow({ entry, testID }: LogEntryRowProps) {
  const time = new Date(entry.timestamp).toLocaleTimeString();
  const levelColor = LEVEL_COLORS[entry.level] ?? 'text-muted-foreground';
  const bgColor = LEVEL_BG[entry.level] ?? 'bg-muted';

  return (
    <View
      className={`border-b border-border px-4 py-2 ${bgColor}`}
      testID={testID}
    >
      <View className="flex-row items-center justify-between">
        <Text className={`text-xs font-bold uppercase ${levelColor}`}>
          {entry.level}
        </Text>
        <Text className="text-xs text-muted-foreground">{time}</Text>
      </View>
      <Text className="mt-1 text-sm text-foreground">{entry.message}</Text>
      {entry.data && (
        <Text className="mt-1 font-mono text-xs text-muted-foreground">
          {JSON.stringify(entry.data, null, 2).slice(0, 200)}
        </Text>
      )}
    </View>
  );
}
