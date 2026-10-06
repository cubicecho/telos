import { useQuery } from '@apollo/client';
import { Text } from 'react-native';
import { ActionButton } from '@/components/action-button';
import { Tag } from '@/components/app-icons';
import { ColorDot } from '@/components/ui/color-dot';
import { LoadState } from '@/components/ui/load-failure';
import { Menu, MenuCheckboxItem, MenuContent, MenuTrigger } from '@/components/ui/menu';
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
  size = 'icon',
  className,
}: {
  attached: readonly LabelSummary[];
  onToggle: (label: LabelSummary, attach: boolean) => void;
  align?: 'start' | 'end';
  /** The trigger's square, from `Button`'s icon ladder. */
  size?: 'icon' | 'icon-sm' | 'icon-xs';
  className?: string;
}) {
  const labelsQuery = useQuery(LabelsDocument);
  const attachedIds = new Set(attached.map((label) => label.id));
  const labels = labelsQuery.data?.labels ?? [];

  return (
    <Menu>
      <MenuTrigger asChild>
        {/* Icon only, to sit in a row of icon actions. The name it lost is its
            `label`, which is also what a resting pointer is shown. */}
        <ActionButton
          variant="ghost"
          size={size}
          className={cn('text-muted-foreground', className)}
          label="Labels"
          iconSlot={<Tag className="h-4 w-4" />}
        />
      </MenuTrigger>
      <MenuContent align={align} aria-label="Labels" className="w-56">
        {/* The failure, not "No labels yet.", when the list did not load: the
            empty line reads as an invitation to go and make one, which is the
            wrong errand when the list simply did not arrive. */}
        <LoadState
          query={labelsQuery}
          what="your labels"
          count={labels.length}
          compact
          rows={2}
          emptySlot={<Text className="px-2 py-3 text-center text-muted-foreground text-sm">No labels yet.</Text>}
        />
        {labels.map((label) => {
          const isAttached = attachedIds.has(label.id);
          return (
            <MenuCheckboxItem
              key={label.id}
              checked={isAttached}
              onCheckedChange={(attach) => onToggle(label, attach)}
              iconSlot={<ColorDot color={label.color} size="sm" />}
              label={label.name}
            />
          );
        })}
      </MenuContent>
    </Menu>
  );
}
