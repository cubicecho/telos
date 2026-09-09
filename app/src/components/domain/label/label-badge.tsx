import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export interface LabelSummary {
  id: string;
  name: string;
  color: string;
}

/**
 * A label's colour is stored as a CSS colour string chosen by the user, so it
 * cannot come from a Tailwind class — it is applied inline, tinting the border
 * and text while the surface stays neutral enough to read at small sizes.
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
      style={{ borderColor: label.color, color: label.color, backgroundColor: `${label.color}14` }}
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
