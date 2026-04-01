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
    <View className="flex-row gap-2 px-4 py-2" testID={testID}>
      {LEVELS.map((level) => {
        const isActive =
          level === 'all' ? !activeLevel : activeLevel === level;
        return (
          <Pressable
            key={level}
            onPress={() => onSelectLevel(level === 'all' ? undefined : level)}
            className={`rounded-full px-3 py-1 ${
              isActive ? 'bg-primary' : 'bg-muted'
            }`}
            testID={testID ? `${testID}-${level}` : undefined}
          >
            <Text
              className={`text-xs font-medium uppercase ${
                isActive ? 'text-primary-foreground' : 'text-muted-foreground'
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
