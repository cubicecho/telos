import type { ReactNode } from 'react';
import * as React from 'react';
import { Platform, Pressable, Text } from 'react-native';
import { cn } from '@/lib/utils';

/**
 * The container class, for a pill the caller renders itself.
 *
 * `hover:` and `transition-colors` are no-ops on device and real on web, which
 * is the intended asymmetry: a pointer exists on one platform and not the other.
 */
export function segmentedItemClass(active: boolean, className?: string) {
  return cn(
    'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
    active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
    className,
  );
}

/**
 * The `<Text>` half of the pill. Native does not inherit colour, so a pill
 * built from a `Pressable` needs the colour on its label, not on its container.
 * A pill built from a router `<Link>` does not need this — a link renders a
 * `Text` and text-in-text does inherit.
 */
export function segmentedTextClass(active: boolean, className?: string) {
  return cn('text-sm font-medium', active ? 'text-primary-foreground' : 'text-muted-foreground', className);
}

export type SegmentedButtonProps = Omit<React.ComponentProps<typeof Pressable>, 'children' | 'className' | 'style'> & {
  active: boolean;
  // Re-declared rather than inherited: nativewind types it as `className?:
  // string`, which under `exactOptionalPropertyTypes` rejects the conditional
  // `cond ? "x" : undefined` that call sites pass.
  className?: string | undefined;
  children: ReactNode;
};

/**
 * A pressable pill.
 *
 * `children` is passed through untouched unless it is a bare string, in which
 * case it is wrapped in a `<Text>` carrying the active colour — the common case,
 * and the one where forgetting the wrapper is a runtime error on native.
 *
 * Takes the rest of a `Pressable`'s props and forwards a ref, the same contract
 * `button.tsx` has and for the same reason: a closed prop set silently drops
 * everything a wrapper tries to hand it — a `TooltipTrigger asChild`'s ref and
 * `aria-*`, an `onLongPress`, a `testID` — with nothing erroring to say so.
 */
const SegmentedButton = React.forwardRef<React.ElementRef<typeof Pressable>, SegmentedButtonProps>(
  ({ active, className, children, ...props }, ref) => {
    return (
      <Pressable
        ref={ref}
        // Hand-written because a `Pressable` has no implicit role, and `selected`
        // is what tells a screen reader which pill of the set is the current one.
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        // The same fact again, in the only spelling the web understands.
        //
        // react-native-web does not read `accessibilityState` at all — it forwards an allowlist of
        // `aria-*` props and nothing else — so without this line the active pill is styled but
        // silent, and a screen reader user cannot tell which of the set is current. It is
        // `aria-pressed` rather than `aria-selected` because this is a `button`, and `aria-selected`
        // is only defined on `option`, `tab`, `row`, `gridcell` and `treeitem`; on a button it is
        // markup axe rejects. React Native has no `aria-pressed`, hence the platform guard.
        {...(Platform.OS === 'web' ? ({ 'aria-pressed': active } as const) : {})}
        className={cn(
          'rounded-md px-3 py-1.5',
          active ? 'bg-primary' : 'hover:bg-muted',
          // The label colour on the container too, which native ignores and web
          // reads: an element child passes through untouched below, so on web its
          // colour can only come from inheriting it here.
          active ? 'text-primary-foreground' : 'text-muted-foreground',
          className,
        )}
        {...props}
      >
        {typeof children === 'string' ? <Text className={segmentedTextClass(active)}>{children}</Text> : children}
      </Pressable>
    );
  },
);
SegmentedButton.displayName = 'SegmentedButton';

export { SegmentedButton };
