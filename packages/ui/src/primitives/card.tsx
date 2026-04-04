import * as React from 'react';
import type { ViewProps } from 'react-native';
import type { ReactNode } from 'react';
import { Text as RNText, View } from 'react-native';

import { Text, TextClassContext } from './text';
import { cn } from './utils';

type CardProps = Omit<ViewProps, 'children'> & { className?: string; children?: ReactNode };
type TextWithClassName = React.ComponentProps<typeof RNText> & { className?: string };

function Card({ className, children, ...props }: CardProps) {
  return (
    <TextClassContext.Provider value="text-neutral-900 dark:text-neutral-100">
      <View
        className={cn(
          'bg-white dark:bg-neutral-900 border-neutral-300 dark:border-neutral-700 flex flex-col gap-6 rounded-xl border py-6 shadow-sm shadow-black/5',
          className
        )}
        {...props}
      >
        {children}
      </View>
    </TextClassContext.Provider>
  );
}

function CardHeader({ className, children, ...props }: CardProps) {
  return <View className={cn('flex flex-col gap-1.5 px-6', className)} {...props}>{children}</View>;
}

function CardTitle({
  className,
  ...props
}: React.ComponentProps<typeof Text> & { className?: string }) {
  return (
    <Text
      role="heading"
      aria-level={3}
      className={cn('font-semibold leading-none', className)}
      {...props}
    />
  );
}

function CardDescription({
  className,
  ...props
}: TextWithClassName) {
  return <RNText className={cn('text-neutral-500 dark:text-neutral-400 text-sm', className)} {...props} />;
}

function CardContent({ className, children, ...props }: CardProps) {
  return <View className={cn('px-6', className)} {...props}>{children}</View>;
}

function CardFooter({ className, children, ...props }: CardProps) {
  return <View className={cn('flex flex-row items-center px-6', className)} {...props}>{children}</View>;
}

export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle };
