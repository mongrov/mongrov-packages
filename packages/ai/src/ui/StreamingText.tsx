import React, { useEffect, useRef } from 'react';
import { Animated, Text } from 'react-native';
import type { StreamingTextProps } from '../types';

export function StreamingText({
  text,
  isStreaming = false,
  cursorChar = '▊',
  className = '',
  testID,
}: StreamingTextProps) {
  const cursorOpacity = useRef(new Animated.Value(1)).current;
  const animationRef = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (isStreaming) {
      // Blinking cursor animation
      animationRef.current = Animated.loop(
        Animated.sequence([
          Animated.timing(cursorOpacity, {
            toValue: 0,
            duration: 500,
            useNativeDriver: true,
          }),
          Animated.timing(cursorOpacity, {
            toValue: 1,
            duration: 500,
            useNativeDriver: true,
          }),
        ])
      );
      animationRef.current.start();
    } else {
      animationRef.current?.stop();
      cursorOpacity.setValue(0);
    }

    return () => {
      animationRef.current?.stop();
    };
  }, [isStreaming, cursorOpacity]);

  return (
    <Text className={`text-foreground ${className}`} testID={testID}>
      {text}
      {isStreaming && (
        <Animated.Text style={{ opacity: cursorOpacity }}>
          {cursorChar}
        </Animated.Text>
      )}
    </Text>
  );
}
