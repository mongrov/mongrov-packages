import React from 'react';
import { Pressable, Text, View } from 'react-native';
import type { LogLevel } from '../types';
import type { LogFilterBarProps } from './types';

const LEVELS: (LogLevel | 'all')[] = ['all', 'debug', 'info', 'warn', 'error'];

export function LogFilterBar({
  activeLevel,
  onSelectLevel,
  testID,
}: LogFilterBarProps) {
  return (
    <View className="flex-row gap-2 px-4 py-3 border-b border-neutral-200 dark:border-neutral-800" testID={testID}>
      {LEVELS.map((level) => {
        const isActive =
          level === 'all' ? !activeLevel : activeLevel === level;
        return (
          <Pressable
            key={level}
            onPress={() => onSelectLevel(level === 'all' ? undefined : level)}
            className={`rounded-full px-3 py-1.5 ${
              isActive
                ? 'bg-primary-500 dark:bg-primary-600'
                : 'bg-neutral-100 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-600'
            }`}
            testID={testID ? `${testID}-${level}` : undefined}
          >
            <Text
              className={`text-xs font-semibold uppercase ${
                isActive
                  ? 'text-white'
                  : 'text-neutral-600 dark:text-neutral-300'
              }`}
            >
              {level}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
