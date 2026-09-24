import { Pressable, View } from 'react-native';
import { Badge } from '@/components/ui/badge';
import { X } from '@/components/ui/icons';
import { readableTextColor } from '@/lib/readable-text-color';
import { cn } from '@/lib/utils';

export interface LabelSummary {
  id: string;
  name: string;
  color: string;
}

/**
 * A label's colour is chosen by the user, so it cannot come from a Tailwind
 * class — it is the badge's backdrop, applied inline. The text on top is picked
 * per colour rather than fixed: the palette runs from teal to crimson, and no
 * single ink reads on all of it. Painting the colour as *text* instead was the
 * previous shape and it failed in the dark theme, where a dark label sat all but
 * invisible on a near-black surface.
 *
 * cubeui's `Badge` has no remove control, so the ✕ sits beside it in a shared
 * pill rather than inside it. Local patch until cubicecho/cubeui#113.
 */
export function LabelBadge({
  label,
  onRemove,
  className,
}: {
  label: LabelSummary;
  onRemove?: () => void;
  className?: string;
}) {
  const ink = readableTextColor(label.color);
  if (!onRemove) {
    return (
      <Badge backgroundColor={label.color} textColor={ink} className={className}>
        {label.name}
      </Badge>
    );
  }
  return (
    <View
      className={cn('shrink-0 flex-row items-center self-start rounded-full pr-1.5', className)}
      style={{ backgroundColor: label.color }}
    >
      <Badge backgroundColor={label.color} textColor={ink} className="pr-1">
        {label.name}
      </Badge>
      <Pressable
        role="button"
        onPress={onRemove}
        className="opacity-60 hover:opacity-100"
        aria-label={`Remove ${label.name}`}
      >
        <X className="h-3 w-3" {...(ink ? { color: ink } : {})} />
      </Pressable>
    </View>
  );
}
