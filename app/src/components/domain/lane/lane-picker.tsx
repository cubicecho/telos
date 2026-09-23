import { useState } from 'react';
import { Text } from 'react-native';
import { Columns3 } from '@/components/app-icons';
import { Button } from '@/components/ui/button';
import { Check } from '@/components/ui/icons';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { LaneSummary } from './lane-badge';
import { MenuItem } from './menu-item';

/**
 * "Move to", as a menu.
 *
 * The board's own answer to this is dragging, which a pointer makes obvious and
 * a keyboard cannot reach at all. This is the same move stated as a list, so
 * every todo can change columns from the list view, from a keyboard, and from a
 * screen reader — not only from the board.
 *
 * A locked todo still opens the menu: the other columns are disabled rather
 * than hidden, and the reason is spelled out under them, so the answer to "why
 * can I not move this" is in the same place as the attempt.
 */
export function LanePicker({
  lanes,
  current,
  onSelect,
  lockedReason,
  align = 'start',
  className,
}: {
  lanes: readonly LaneSummary[];
  current: LaneSummary | null;
  onSelect: (lane: LaneSummary) => void;
  /** Why this todo cannot change column, when it cannot. */
  lockedReason?: string | null;
  align?: 'start' | 'end';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  if (lanes.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn('text-muted-foreground', className)}
          aria-label={current ? `Lane, currently ${current.name}` : 'Lane'}
          // Radix opens from the trigger's `onClick`, which react-native-web's
          // Pressable swallows — see dependency-picker.tsx.
          onPress={() => setOpen(!open)}
        >
          <Columns3 className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-52 p-1">
        {lanes.map((lane) => (
          <MenuItem
            key={lane.id}
            label={lane.name}
            disabled={lockedReason != null && lane.id !== current?.id}
            onSelect={() => {
              setOpen(false);
              onSelect(lane);
            }}
            trailing={
              <>
                {lane.isDone ? <Text className="text-muted-foreground text-xs">done</Text> : null}
                {lane.id === current?.id ? <Check className="h-3.5 w-3.5" /> : null}
              </>
            }
          />
        ))}
        {lockedReason ? <Text className="px-2 py-1.5 text-muted-foreground text-xs">{lockedReason}</Text> : null}
      </PopoverContent>
    </Popover>
  );
}
