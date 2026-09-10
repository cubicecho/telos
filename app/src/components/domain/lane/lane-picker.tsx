import * as Popover from '@radix-ui/react-popover';
import { Check, Columns3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { LaneSummary } from './lane-badge';

/**
 * "Move to", as a menu.
 *
 * The board's own answer to this is dragging, which a pointer makes obvious and
 * a keyboard cannot reach at all. This is the same move stated as a list, so
 * every todo can change columns from the list view, from a keyboard, and from a
 * screen reader — not only from the board.
 */
export function LanePicker({
  lanes,
  current,
  onSelect,
  align = 'start',
  className,
}: {
  lanes: readonly LaneSummary[];
  current: LaneSummary | null;
  onSelect: (lane: LaneSummary) => void;
  align?: 'start' | 'end';
  className?: string;
}) {
  if (lanes.length === 0) return null;

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn('text-muted-foreground', className)}
          aria-label={current ? `Lane, currently ${current.name}` : 'Lane'}
          title={current ? `Lane: ${current.name}` : 'Move to…'}
        >
          <Columns3 className="h-4 w-4" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={6}
          align={align}
          className="z-50 w-52 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {lanes.map((lane) => (
            <Popover.Close asChild key={lane.id}>
              <button
                type="button"
                onClick={() => onSelect(lane)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              >
                <span className="flex-1 truncate">{lane.name}</span>
                {lane.isDone ? <span className="text-muted-foreground text-xs">done</span> : null}
                {lane.id === current?.id ? <Check className="h-3.5 w-3.5" /> : null}
              </button>
            </Popover.Close>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
