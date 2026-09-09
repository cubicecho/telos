import { useQuery } from '@apollo/client';
import * as Popover from '@radix-ui/react-popover';
import { Check, Tag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LabelsDocument } from '@/lib/graphql';
import type { LabelSummary } from './label-badge';

/**
 * Attach/detach in one list rather than two flows: the caller gets told which
 * label was toggled and decides which junction to write.
 */
export function LabelPicker({
  attached,
  onToggle,
}: {
  attached: readonly LabelSummary[];
  onToggle: (label: LabelSummary, attach: boolean) => void;
}) {
  const { data } = useQuery(LabelsDocument);
  const attachedIds = new Set(attached.map((label) => label.id));
  const labels = data?.labels ?? [];

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="ghost" size="sm" className="text-muted-foreground">
          <Tag className="mr-1 h-3.5 w-3.5" />
          Labels
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={6}
          align="start"
          className="z-50 w-56 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {labels.length === 0 ? (
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
