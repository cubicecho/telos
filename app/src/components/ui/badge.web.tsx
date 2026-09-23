import { Slot } from 'radix-ui';
import type * as React from 'react';
import {
  type BadgeProps,
  type BadgeVariant,
  badgeContainerVariants,
  badgeHasLabel,
  badgeTextFallback,
  badgeTextVariants,
  badgeVariants,
} from '@/components/ui/badge-base';
import { cn } from '@/lib/utils';

export type { BadgeProps, BadgeVariant };

export function Badge({
  variant = 'default',
  backgroundColor,
  textColor,
  className,
  label,
  asChild = false,
  style,
  children,
  ...props
}: BadgeProps &
  Omit<React.ComponentProps<'span'>, keyof BadgeProps> & {
    /** Render the single child with the badge's classes instead of a `<span>`. */
    asChild?: boolean | undefined;
  }) {
  const shape = asChild || badgeHasLabel(children) ? 'pill' : 'dot';
  const Comp = asChild ? Slot.Root : 'span';

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(
        'inline-flex w-fit overflow-hidden whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 [&>svg]:pointer-events-none [&>svg]:size-3',
        badgeContainerVariants({ variant, shape }),
        shape === 'pill' && (backgroundColor ? badgeTextFallback : badgeTextVariants({ variant })),
        variant === 'link' && '[a&]:hover:underline',
        className,
      )}
      style={{
        ...(backgroundColor ? { backgroundColor } : {}),
        ...(textColor ? { color: textColor } : {}),
        ...style,
      }}
      // A dot carries meaning and no text, so it is named or it is decoration;
      // the same split `color-dot` makes, for the same reason.
      {...(shape === 'dot'
        ? label
          ? ({ role: 'img', 'aria-label': label } as const)
          : ({ 'aria-hidden': true } as const)
        : {})}
      {...props}
    >
      {shape === 'pill' ? children : null}
    </Comp>
  );
}

export { badgeVariants };
