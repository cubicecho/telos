import { cn } from '@/lib/utils';

export interface Segment<T extends string> {
  value: T;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
}

/**
 * A small set of mutually exclusive views, shown all at once.
 *
 * Radix has no tabs package installed here, and this needs less than one: the
 * panel is rendered by the caller, so all this owns is the choice. It carries
 * the tab roles anyway — a screen reader should hear "tab, 1 of 2", not two
 * unrelated buttons — and answers the arrow keys the roles promise.
 */
export function SegmentedControl<T extends string>({
  value,
  segments,
  onChange,
  label,
  idPrefix,
  className,
}: {
  value: T;
  segments: readonly Segment<T>[];
  onChange: (value: T) => void;
  label: string;
  /** Shared with `segmentPanelProps` so each tab can point at its panel. */
  idPrefix: string;
  className?: string;
}) {
  function onKeyDown(event: React.KeyboardEvent) {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const at = segments.findIndex((segment) => segment.value === value);
    // Wraps, which is what the tab role's keyboard contract describes.
    const next = segments[(at + step + segments.length) % segments.length];
    if (next) onChange(next.value);
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn('inline-flex items-center gap-1 rounded-lg bg-muted p-1', className)}
    >
      {segments.map((segment) => {
        const selected = segment.value === value;
        const Icon = segment.icon;
        return (
          <button
            key={segment.value}
            type="button"
            role="tab"
            id={`${idPrefix}-${segment.value}`}
            aria-controls={`${idPrefix}-${segment.value}-panel`}
            aria-selected={selected}
            // Only the selected tab is in the tab order; the arrows move between
            // them, which is the other half of the same contract.
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(segment.value)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-3 py-1 font-medium text-sm transition-colors',
              selected ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {Icon ? <Icon className="h-4 w-4" /> : null}
            {segment.label}
          </button>
        );
      })}
    </div>
  );
}

/** The attributes that pair a rendered panel with the tab that selected it. */
export function segmentPanelProps(idPrefix: string, value: string) {
  return { role: 'tabpanel' as const, id: `${idPrefix}-${value}-panel`, 'aria-labelledby': `${idPrefix}-${value}` };
}
