import type { ReactNode } from 'react';
import { Pressable, Text } from 'react-native';
import { IconClassContext } from '@/components/ui/icons-base';
import { cn } from '@/lib/utils';

/**
 * One action in a popover menu — a row, not a button of its own.
 *
 * cubeui's `Popover` has no `Close`, so the caller owns the open state and
 * `onSelect` is expected to close it.
 */
export function MenuItem({
  onSelect,
  label,
  icon,
  trailing,
  destructive,
  disabled,
}: {
  onSelect: () => void;
  label: string;
  /** Leading glyph; takes the row's ink through `IconClassContext`. */
  icon?: ReactNode;
  /** Anything after the label — a hint, a tick. */
  trailing?: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
}) {
  const ink = destructive ? 'text-destructive' : 'text-popover-foreground';
  return (
    <Pressable
      role="menuitem"
      disabled={disabled}
      aria-disabled={disabled}
      onPress={onSelect}
      className={cn(
        'w-full flex-row items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-accent',
        disabled && 'opacity-50',
      )}
    >
      <IconClassContext.Provider value={ink}>
        {icon}
        <Text numberOfLines={1} className={cn('flex-1 text-sm', ink)}>
          {label}
        </Text>
        {trailing}
      </IconClassContext.Provider>
    </Pressable>
  );
}
