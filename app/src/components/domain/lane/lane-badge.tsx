import { cn } from '@/lib/utils';

/** The shape every lane-aware component reads. */
export interface LaneSummary {
  id: string;
  name: string;
  position: number;
  isDone: boolean;
}

/**
 * A todo's column, shown on the list view so the two tabs tell the same story.
 * The done lane is deliberately unstyled here — the checkbox and the strike
 * through already say a todo is finished, and a third marker only adds noise.
 */
export function LaneBadge({ lane, className }: { lane: LaneSummary; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 font-medium text-[11px] text-muted-foreground leading-4',
        className,
      )}
    >
      {lane.name}
    </span>
  );
}
