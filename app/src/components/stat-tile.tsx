import type { ReactNode } from 'react';
import { Platform, Text, View } from 'react-native';
import { Card } from '@/components/ui/card';
import { IconClassContext } from '@/components/ui/icons-base';
import { cn } from '@/lib/utils';

type StatTileProps = {
  /** What the figure is called: "Turns", "Daily average". Drawn above it, muted. */
  label: ReactNode;
  /**
   * The figure: a string or a number, drawn large in tabular numerals so a row of tiles lines up
   * as it ticks. A node works too — a `ColorDot` beside a category's name — and is placed as is.
   */
  value: ReactNode;
  /**
   * One muted line under the figure: what it is out of, or where it comes from — "over 7 days",
   * "schema v4". Read after the value, as part of the tile.
   */
  hint?: ReactNode | undefined;
  /** Before the label. A bare `<Clock />`; the tile sizes it and mutes it. */
  icon?: ReactNode | undefined;
  /**
   * Whether the figure is still being fetched. On, a bar stands in for the value and the label
   * stays — the tile is as tall as it will be, so a row of them does not jump when the data lands.
   */
  loading?: boolean | undefined;
  /**
   * Makes the whole tile a button: a filter to toggle, a page to open. The tile's text is its
   * accessible name, so a count and its label are read together.
   */
  onPress?: (() => void) | undefined;
  /**
   * With `onPress`, the tile is a toggle and this is whether it is on — the filter tile over a
   * list. Left out, the tile is a plain button. Without `onPress` it is ignored.
   */
  selected?: boolean | undefined;
  className?: string | undefined;
  /** The figure's class: the colour a count takes when it is one worth noticing. */
  valueClassName?: string | undefined;
};

/** The icon's box: sized from outside on the web, and by `IconClassContext` on device. */
const ICON_BOX = cn('shrink-0', Platform.select({ web: '[&_svg]:size-4 [&_svg]:shrink-0', default: undefined }));

/**
 * The muted parts' ink — the label, the hint and the icon. A selected tile is on `bg-accent`, where
 * `text-muted-foreground` is 4.3:1 in the light theme and worse in the dark, so the hand-written
 * filter tiles' labels all failed contrast the moment they were chosen. On the accent they take
 * the accent's own foreground.
 */
const MUTED_INK = {
  idle: 'text-muted-foreground',
  selected: 'text-accent-foreground',
} as const;

/** A bar standing in for the figure — `Skeleton`'s look, on both platforms, at one line of it. */
const BAR = cn('h-8 w-20 rounded-md bg-accent', Platform.OS === 'web' && 'animate-pulse');

/**
 * What a pressable tile adds on the web: a compiled `Pressable` is a `<button>`, which centres its
 * text and draws no focus ring of its own. None of it is a class the device can read.
 */
const PRESSABLE = Platform.select({
  web: 'text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
  default: undefined,
});

/**
 * A wrapper around a caller's node, not layout of its own: a block box on the web, where a compiled
 * view would otherwise be a flex column and lay a dot and a name out as two rows.
 */
const SLOT = Platform.select({ web: 'block', default: undefined });

export function StatTile({
  label,
  value,
  hint,
  icon,
  loading = false,
  onPress,
  selected,
  className,
  valueClassName,
}: StatTileProps) {
  const toggle = onPress !== undefined && selected !== undefined;
  // The pressed state in each platform's spelling. react-native-web forwards `aria-*` and drops
  // `accessibilityState`; the device reads `accessibilityState` and has no `aria-pressed`.
  const pressed = toggle
    ? Platform.OS === 'web'
      ? { 'aria-pressed': selected }
      : { accessibilityState: { selected } }
    : {};

  const ink = MUTED_INK[toggle && selected ? 'selected' : 'idle'];
  const classes = cn(
    'min-w-0 gap-1 p-4',
    onPress !== undefined && PRESSABLE,
    toggle && selected && 'border-selection bg-accent',
    className,
  );

  const body = (
    <>
      <View testID="stat-tile-label-row" className="min-w-0 flex-row items-center gap-2">
        {icon ? (
          <View testID="stat-tile-icon" aria-hidden className={cn(ICON_BOX, ink)}>
            <IconClassContext.Provider value={cn('size-4 shrink-0', ink)}>{icon}</IconClassContext.Provider>
          </View>
        ) : null}
        <Text testID="stat-tile-label" className={cn('min-w-0 flex-1 truncate font-medium text-sm', ink)}>
          {label}
        </Text>
      </View>
      {loading ? (
        <View testID="stat-tile-skeleton" aria-hidden className={BAR} />
      ) : typeof value === 'string' || typeof value === 'number' ? (
        <Text
          testID="stat-tile-value"
          className={cn('font-semibold text-2xl text-card-foreground tabular-nums', valueClassName)}
        >
          {value}
        </Text>
      ) : (
        <View testID="stat-tile-value" className={cn(SLOT, 'min-w-0', valueClassName)}>
          {value}
        </View>
      )}
      {hint ? (
        <Text testID="stat-tile-hint" className={cn('text-xs', ink)}>
          {hint}
        </Text>
      ) : null}
    </>
  );

  // `Card` is the one that turns into a `Pressable` when it is handed `onPress`, and stays a view
  // when it is handed `undefined` — so a tile nobody can press is not a button.
  return (
    <Card testID="stat-tile" onPress={onPress} aria-busy={loading || undefined} className={classes} {...pressed}>
      {body}
    </Card>
  );
}
