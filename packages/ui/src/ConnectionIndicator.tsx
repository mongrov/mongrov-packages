import React, { useEffect, useRef } from 'react';
import { Animated, View } from 'react-native';
import type { ConnectionIndicatorProps, ConnectionStatus } from './types';

const statusColor: Record<ConnectionStatus, string> = {
  connected: 'bg-success',
  connecting: 'bg-warning',
  disconnected: 'bg-destructive',
};

export function ConnectionIndicator({ status, testID }: ConnectionIndicatorProps) {
  const opacity = useRef(new Animated.Value(1)).current;
  const animation = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (status === 'connecting') {
      animation.current = Animated.loop(
        Animated.timing(opacity, {
          toValue: 0.3,
          duration: 800,
          useNativeDriver: true,
        }),
      );
      animation.current.start();
    } else {
      animation.current?.stop();
      opacity.setValue(1);
    }

    return () => {
      animation.current?.stop();
    };
  }, [status, opacity]);

  return (
    <View testID={testID}>
      <Animated.View
        className={`h-3 w-3 rounded-full ${statusColor[status]}`}
        style={{ opacity }}
      />
    </View>
  );
}
