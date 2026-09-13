import { useQuery } from '@apollo/client';
import * as Popover from '@radix-ui/react-popover';
import { Check, Tag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LoadFailure } from '@/components/ui/load-failure';
import { LabelsDocument } from '@/lib/graphql';
import { cn } from '@/lib/utils';
import type { LabelSummary } from './label-badge';

/**
 * Attach/detach in one list rather than two flows: the caller gets told which
 * label was toggled and decides which junction to write.
 */
export function LabelPicker({
  attached,
  onToggle,
  // Which edge the panel hangs from. A trigger sitting at the right of its row
  // wants `end`, or the panel opens away from the content it belongs to.
  align = 'start',
  className,
}: {
  attached: readonly LabelSummary[];
  onToggle: (label: LabelSummary, attach: boolean) => void;
  align?: 'start' | 'end';
  className?: string;
}) {
  const { data, error, refetch } = useQuery(LabelsDocument);
  const attachedIds = new Set(attached.map((label) => label.id));
  const labels = data?.labels ?? [];

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        {/* Icon only, to sit in a row of icon actions. The name it lost is in
            `aria-label` for a screen reader and in `title` for a pointer. */}
        <Button
          variant="ghost"
          size="icon"
          className={cn('text-muted-foreground', className)}
          aria-label="Labels"
          title="Labels"
        >
          <Tag className="h-4 w-4" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={6}
          align={align}
          className="z-50 w-56 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {error && labels.length === 0 ? (
            /* "No labels yet." here would read as an invitation to go and make
               one, which is the wrong errand when the list simply did not
               load. */
            <LoadFailure error={error} onRetry={refetch} className="px-2 py-3" />
          ) : labels.length === 0 ? (
            <p className="px-2 py-3 text-center text-muted-foreground text-sm">No labels yet.</p>
          ) : (
            labels.map((label) => {
              const isAttached = attachedIds.has(label.id);
              return (
                <button
                  key={label.id}
                  type="button"
                  onClick={() => onToggle(label, !isAttached)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                >
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: label.color }} />
                  <span className="flex-1 truncate">{label.name}</span>
                  {isAttached ? <Check className="h-3.5 w-3.5" /> : null}
                </button>
              );
            })
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
