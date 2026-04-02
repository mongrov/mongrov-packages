import React from 'react';
import { Text, View } from 'react-native';
import type { LogEntryRowProps } from './types';

const LEVEL_COLORS: Record<string, string> = {
  debug: 'text-neutral-600 dark:text-neutral-300',
  info: 'text-blue-600 dark:text-blue-400',
  warn: 'text-warning-600 dark:text-warning-400',
  error: 'text-danger-600 dark:text-danger-400',
};

const LEVEL_BG: Record<string, string> = {
  debug: 'bg-neutral-50 dark:bg-neutral-900',
  info: 'bg-blue-50 dark:bg-blue-900/30',
  warn: 'bg-warning-50 dark:bg-warning-900/30',
  error: 'bg-danger-50 dark:bg-danger-900/30',
};

export function LogEntryRow({ entry, testID }: LogEntryRowProps) {
  const time = new Date(entry.timestamp).toLocaleTimeString();
  const levelColor = LEVEL_COLORS[entry.level] ?? 'text-neutral-500 dark:text-neutral-400';
  const bgColor = LEVEL_BG[entry.level] ?? 'bg-neutral-100 dark:bg-neutral-800';

  return (
    <View
      className={`border-b border-neutral-200 dark:border-neutral-700 px-4 py-2 ${bgColor}`}
      testID={testID}
    >
      <View className="flex-row items-center justify-between">
        <Text className={`text-xs font-bold uppercase ${levelColor}`}>
          {entry.level}
        </Text>
        <Text className="text-xs text-neutral-500 dark:text-neutral-400">{time}</Text>
      </View>
      <Text className="mt-1 text-sm text-neutral-900 dark:text-neutral-100">{entry.message}</Text>
      {entry.data && (
        <Text className="mt-1 font-mono text-xs text-neutral-500 dark:text-neutral-400">
          {JSON.stringify(entry.data, null, 2).slice(0, 200)}
        </Text>
      )}
    </View>
  );
}
