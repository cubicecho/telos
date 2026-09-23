import { useQuery } from '@apollo/client';
import { useState } from 'react';
import { Pressable, Text } from 'react-native';
import { Tag } from '@/components/app-icons';
import { Button } from '@/components/ui/button';
import { ColorDot } from '@/components/ui/color-dot';
import { Check } from '@/components/ui/icons';
import { LoadFailure } from '@/components/ui/load-failure';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* Icon only, to sit in a row of icon actions. The name it lost is in
            `aria-label`. (The DOM `title` it also had is not a Pressable prop;
            a pointer hint would be cubeui's Tooltip.) */}
        <Button
          variant="ghost"
          size="icon"
          className={cn('text-muted-foreground', className)}
          aria-label="Labels"
          // Radix opens from the trigger's `onClick`, which react-native-web's
          // Pressable swallows — see dependency-picker.tsx.
          onPress={() => setOpen(!open)}
        >
          <Tag className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-56 p-1">
        {error && labels.length === 0 ? (
          /* "No labels yet." here would read as an invitation to go and make
             one, which is the wrong errand when the list simply did not
             load. */
          <LoadFailure error={error} onRetry={refetch} what="your labels" compact />
        ) : labels.length === 0 ? (
          <Text className="px-2 py-3 text-center text-muted-foreground text-sm">No labels yet.</Text>
        ) : (
          labels.map((label) => {
            const isAttached = attachedIds.has(label.id);
            return (
              <Pressable
                key={label.id}
                role="checkbox"
                aria-checked={isAttached}
                onPress={() => onToggle(label, !isAttached)}
                className="w-full flex-row items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-accent"
              >
                <ColorDot color={label.color} size="sm" />
                <Text numberOfLines={1} className="flex-1 text-popover-foreground text-sm">
                  {label.name}
                </Text>
                {isAttached ? <Check className="h-3.5 w-3.5" /> : null}
              </Pressable>
            );
          })
        )}
      </PopoverContent>
    </Popover>
  );
}
