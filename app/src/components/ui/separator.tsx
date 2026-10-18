/**
 * A one-pixel rule between groups: shadcn's `Separator`, on both halves. It is `decorative` by
 * default and hidden from assistive tech; `decorative={false}` makes it a `role="separator"`, for
 * a rule that is the only thing marking a boundary.
 *
 * The size is a plain class per orientation, because react-native-web does not forward the
 * `data-orientation` a variant would match. Vertical is `self-stretch` on device rather than
 * `h-full`: a percentage of a row whose height is its content is zero in Yoga.
 */
import type * as React from 'react';
import { Platform, View } from 'react-native';
import { cn } from '@/lib/utils';

const ORIENTATIONS = {
  horizontal: 'h-px w-full',
  vertical: Platform.select({ web: 'h-full w-px', default: 'w-px self-stretch' }),
} as const;

type SeparatorProps = Omit<React.ComponentProps<typeof View>, 'className' | 'children'> & {
  className?: string | undefined;
  /** Which way the rule runs. `horizontal` divides stacked groups, `vertical` side-by-side ones. */
  orientation?: keyof typeof ORIENTATIONS | undefined;
  /**
   * Hidden from assistive tech, the default. `false` makes it a `role="separator"` a screen
   * reader announces — for a boundary nothing else on the screen says.
   */
  decorative?: boolean | undefined;
};

/** A one-pixel rule between groups, horizontal or vertical. */
function Separator({ className, orientation = 'horizontal', decorative = true, ...props }: SeparatorProps) {
  return (
    <View
      testID="separator"
      {...(decorative
        ? ({ 'aria-hidden': true } as const)
        : ({
            role: 'separator',
            // Radix's: said only when it is not the default. React Native has no such prop and
            // ignores it; react-native-web and the compiled half write it.
            'aria-orientation': orientation === 'vertical' ? 'vertical' : undefined,
          } as const))}
      {...(Platform.OS === 'web' ? ({ 'data-orientation': orientation } as const) : {})}
      className={cn('shrink-0 bg-foreground/10', ORIENTATIONS[orientation], className)}
      {...props}
    />
  );
}

export type { SeparatorProps };
export { Separator };
