import { Text } from 'react-native';
import { Columns3 } from '@/components/app-icons';
import { Button } from '@/components/ui/button';
import { Check } from '@/components/ui/icons';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import { cn } from '@/lib/utils';
import type { LaneSummary } from './lane-badge';

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
  if (lanes.length === 0) return null;

  return (
    <Menu>
      <MenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn('text-muted-foreground', className)}
          aria-label={current ? `Lane, currently ${current.name}` : 'Lane'}
        >
          <Columns3 className="h-4 w-4" />
        </Button>
      </MenuTrigger>
      <MenuContent align={align} className="w-52">
        {lanes.map((lane) => (
          <MenuItem
            key={lane.id}
            label={lane.name}
            disabled={lockedReason != null && lane.id !== current?.id}
            onSelect={() => onSelect(lane)}
            trailing={
              <>
                {lane.isDone ? <Text className="text-muted-foreground text-xs">done</Text> : null}
                {lane.id === current?.id ? <Check className="h-3.5 w-3.5" /> : null}
              </>
            }
          />
        ))}
        {lockedReason ? <Text className="px-2 py-1.5 text-muted-foreground text-xs">{lockedReason}</Text> : null}
      </MenuContent>
    </Menu>
  );
}
