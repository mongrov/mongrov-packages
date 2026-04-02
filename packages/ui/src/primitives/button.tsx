import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, Text } from 'react-native';

import { TextClassContext } from './text';
import { cn } from './utils';

const buttonVariants = cva(
  cn(
    'group shrink-0 flex-row items-center justify-center gap-2 rounded-md shadow-none',
    Platform.select({
      web: "focus-visible:ring-primary-600/50 whitespace-nowrap outline-none transition-all focus-visible:ring-[3px] disabled:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
    })
  ),
  {
    variants: {
      variant: {
        default: cn(
          'bg-primary-600 active:bg-primary-700 shadow-sm shadow-black/5',
          Platform.select({ web: 'hover:bg-primary-700' })
        ),
        destructive: cn(
          'bg-danger-500 active:bg-danger-600 shadow-sm shadow-black/5',
          Platform.select({
            web: 'hover:bg-danger-600',
          })
        ),
        outline: cn(
          'border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 active:bg-neutral-100 dark:active:bg-neutral-800 border shadow-sm shadow-black/5',
          Platform.select({
            web: 'hover:bg-neutral-100 dark:hover:bg-neutral-800',
          })
        ),
        secondary: cn(
          'bg-neutral-200 dark:bg-neutral-700 active:bg-neutral-300 dark:active:bg-neutral-600 shadow-sm shadow-black/5',
          Platform.select({ web: 'hover:bg-neutral-300 dark:hover:bg-neutral-600' })
        ),
        ghost: cn(
          'active:bg-neutral-100 dark:active:bg-neutral-800',
          Platform.select({ web: 'hover:bg-neutral-100 dark:hover:bg-neutral-800' })
        ),
        link: '',
      },
      size: {
        default: cn('h-10 px-4 py-2 sm:h-9', Platform.select({ web: 'has-[>svg]:px-3' })),
        sm: cn('h-9 gap-1.5 rounded-md px-3 sm:h-8', Platform.select({ web: 'has-[>svg]:px-2.5' })),
        lg: cn('h-11 rounded-md px-6 sm:h-10', Platform.select({ web: 'has-[>svg]:px-4' })),
        icon: 'h-10 w-10 sm:h-9 sm:w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

const buttonTextVariants = cva(
  cn(
    'text-neutral-900 dark:text-neutral-100 text-sm font-medium',
    Platform.select({ web: 'pointer-events-none transition-colors' })
  ),
  {
    variants: {
      variant: {
        default: 'text-white',
        destructive: 'text-white',
        outline: cn(
          'text-neutral-900 dark:text-neutral-100 group-active:text-neutral-900 dark:group-active:text-neutral-100',
          Platform.select({ web: 'group-hover:text-neutral-900 dark:group-hover:text-neutral-100' })
        ),
        secondary: 'text-neutral-900 dark:text-neutral-100',
        ghost: 'text-neutral-900 dark:text-neutral-100 group-active:text-neutral-900',
        link: cn(
          'text-primary-600 dark:text-primary-400 group-active:underline',
          Platform.select({ web: 'underline-offset-4 hover:underline group-hover:underline' })
        ),
      },
      size: {
        default: '',
        sm: '',
        lg: '',
        icon: '',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

type ButtonProps = React.ComponentProps<typeof Pressable> &
  VariantProps<typeof buttonVariants> & {
    className?: string;
    label?: string;
    loading?: boolean;
  };

function Button({ className, variant, size, label, loading, children, ...props }: ButtonProps) {
  const textClassName = buttonTextVariants({ variant, size });

  return (
    <TextClassContext.Provider value={textClassName}>
      <Pressable
        className={cn(
          (props.disabled || loading) && 'opacity-50',
          buttonVariants({ variant, size }),
          className
        )}
        disabled={props.disabled || loading}
        role="button"
        {...props}
      >
        {loading ? (
          <ActivityIndicator
            size="small"
            className={cn(
              variant === 'default' || variant === 'destructive'
                ? 'text-white'
                : 'text-neutral-900 dark:text-neutral-100'
            )}
          />
        ) : children ? (
          children
        ) : label ? (
          <Text className={textClassName}>{label}</Text>
        ) : null}
      </Pressable>
    </TextClassContext.Provider>
  );
}

export { Button, buttonTextVariants, buttonVariants };
export type { ButtonProps };
