import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
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
  return (
    <Badge
      variant="outline"
      className={cn('gap-1', className)}
      style={{ borderColor: label.color, backgroundColor: label.color, color: readableTextColor(label.color) }}
    >
      {label.name}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="opacity-60 hover:opacity-100"
          aria-label={`Remove ${label.name}`}
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </Badge>
  );
}
