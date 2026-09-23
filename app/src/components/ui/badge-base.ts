import { cva } from 'class-variance-authority';
import type { ReactNode } from 'react';

export type BadgeVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'ghost'
  | 'link'
  | 'success'
  | 'warning';

export type BadgeProps = {
  variant?: BadgeVariant | undefined;
  /**
   * Overrides the variant's background with a literal colour — for a badge
   * standing in for a user-chosen tag or category. Passing it also drops the
   * variant's label colour, since the caller's background is unknown and
   * `text-primary-foreground` would be a guess. Pair it with `readableTextColor`
   * when the label has to stay legible on an arbitrary hue.
   */
  backgroundColor?: string | undefined;
  /**
   * Overrides the label's colour, for the same case as `backgroundColor`: with an
   * arbitrary hue behind it, neither the variant's label colour nor the
   * `text-foreground` fallback is guaranteed to be legible. `readableTextColor`
   * is what computes the value to pass.
   */
  textColor?: string | undefined;
  className?: string | undefined;
  /**
   * What the dot stands for, exposed as its accessible name. Ignored in the
   * pill form, where the label is already the name.
   */
  label?: string | undefined;
  /**
   * The label: text, a number, or elements such as an icon beside text. Absent —
   * including an empty string — collapses the badge to a dot.
   */
  children?: ReactNode;
};

/** Whether `children` holds anything to show, which is what decides pill or dot. */
export function badgeHasLabel(children: ReactNode): boolean {
  return !(children === undefined || children === null || children === false || children === '');
}

/**
 * No `align-self` here: a badge beside a select or a button takes the row's `items-center` like
 * everything else in it. Keeping it from stretching down a column is each half's job — `w-fit`
 * on the web, `self-start` on native, where Yoga has no fit-content.
 *
 * The container: shape and background. `shape` is derived from whether a label
 * was passed, not taken as a prop — a dot is what a badge with nothing to say
 * already is, and making it a second axis would allow the two states that mean
 * nothing: a dot with a label it cannot show, and an empty pill.
 */
export const badgeContainerVariants = cva('shrink-0 rounded-full border border-transparent', {
  variants: {
    variant: {
      default: 'bg-primary',
      secondary: 'bg-secondary',
      destructive: 'bg-destructive',
      outline: 'border-border bg-transparent',
      ghost: 'bg-transparent',
      link: 'bg-transparent',
      success: 'bg-green-700',
      warning: 'bg-amber-700',
    },
    shape: {
      pill: 'flex-row items-center justify-center gap-1 px-2 py-0.5',
      dot: 'h-2 w-2',
    },
  },
  defaultVariants: { variant: 'default', shape: 'pill' },
});

/** The label's type and colour, per variant. */
export const badgeTextVariants = cva('text-xs font-medium', {
  variants: {
    variant: {
      default: 'text-primary-foreground',
      secondary: 'text-secondary-foreground',
      destructive: 'text-white',
      outline: 'text-foreground',
      ghost: 'text-foreground',
      link: 'text-primary underline-offset-4',
      success: 'text-white',
      warning: 'text-white',
    },
  },
  defaultVariants: { variant: 'default' },
});

/** The label's class when `backgroundColor` replaced the variant's own. */
export const badgeTextFallback = 'text-xs font-medium text-foreground';

/**
 * shadcn's `badgeVariants`: the whole pill's classes, container and label together, for dressing
 * something else — a link, a button — as a badge. The two class maps never touch the same
 * property, so they join without merging.
 */
export function badgeVariants({
  variant,
  shape,
}: {
  variant?: BadgeVariant | null | undefined;
  shape?: 'pill' | 'dot' | null | undefined;
} = {}): string {
  return `${badgeContainerVariants({ variant, shape })} ${badgeTextVariants({ variant })}`;
}
