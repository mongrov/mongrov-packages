import * as SeparatorPrimitive from '@rn-primitives/separator';

import { cn } from './utils';

type SeparatorProps = React.ComponentProps<typeof SeparatorPrimitive.Root> & { className?: string };

function Separator({
  className,
  orientation = 'horizontal',
  decorative = true,
  ...props
}: SeparatorProps) {
  return (
    <SeparatorPrimitive.Root
      decorative={decorative}
      orientation={orientation}
      className={cn(
        'bg-neutral-200 dark:bg-neutral-700 shrink-0',
        orientation === 'horizontal' ? 'h-[1px] w-full' : 'h-full w-[1px]',
        className
      )}
      {...props}
    />
  );
}

export { Separator };
