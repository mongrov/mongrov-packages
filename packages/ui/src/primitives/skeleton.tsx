import * as React from 'react';
import { View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { cn } from './utils';

const duration = 1000;

type SkeletonProps = React.ComponentProps<typeof View> & { className?: string };

function Skeleton({
  className,
  ...props
}: SkeletonProps) {
  const sv = useSharedValue(1);

  React.useEffect(() => {
    sv.value = withRepeat(withTiming(0.5, { duration }), -1, true);
  }, []);

  const style = useAnimatedStyle(
    () => ({
      opacity: sv.value,
    }),
    [sv]
  );
  return (
    <Animated.View
      style={style}
      className={cn('bg-neutral-200 dark:bg-neutral-800 rounded-md', className)}
      {...props}
    />
  );
}

export { Skeleton };
