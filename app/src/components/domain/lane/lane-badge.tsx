import { Text } from 'react-native';
import { Badge } from '@/components/ui/badge';
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
    // The label is its own `Text` so it can be muted: a badge's string ink is the variant's.
    <Badge variant="outline" className={cn('self-auto', className)}>
      <Text className="font-medium text-muted-foreground text-xs">{lane.name}</Text>
    </Badge>
  );
}
