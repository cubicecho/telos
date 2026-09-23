import type { KeyboardEvent } from 'react';
import { Platform, Text, View } from 'react-native';
import type { IconComponent } from '@/components/ui/icons-base';
import { SegmentedButton } from '@/components/ui/segmented';
import { cn } from '@/lib/utils';

export interface Segment<T extends string> {
  value: T;
  label: string;
  icon?: IconComponent;
}

/**
 * A small set of mutually exclusive views, shown all at once.
 *
 * Built on cubeui's `SegmentedButton` for the pill, with the tab semantics laid
 * over it: the panel is rendered by the caller, so all this owns is the
 * choice. It carries the tab roles anyway — a screen reader should hear "tab,
 * 1 of 2", not two unrelated buttons — and answers the arrow keys the roles
 * promise. (cubeui's `tabs` would do the roles, and it can be controlled now,
 * but its device trigger wraps every child in one `<Text>`, so a tab cannot
 * carry an icon beside its label.)
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
  function onKeyDown(event: KeyboardEvent) {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const at = segments.findIndex((segment) => segment.value === value);
    // Wraps, which is what the tab role's keyboard contract describes.
    const next = segments[(at + step + segments.length) % segments.length];
    if (!next) return;
    onChange(next.value);
    // Focus follows the selection, as it would with real tabs. The DOM lookup
    // is web-only, and so is a keyboard that sends arrow keys to a tablist.
    if (Platform.OS === 'web') document.getElementById(`${idPrefix}-${next.value}`)?.focus();
  }

  return (
    <View
      role="tablist"
      aria-label={label}
      // Web only: react-native-web forwards `onKeyDown` to the element, and the
      // handler sits on the list so one listener serves every tab. React
      // Native's types do not declare it, hence the spread.
      {...({ onKeyDown } as object)}
      className={cn('flex-row items-center gap-1 self-start rounded-lg bg-muted p-1', className)}
    >
      {segments.map((segment) => {
        const selected = segment.value === value;
        const Icon = segment.icon;
        return (
          <SegmentedButton
            key={segment.value}
            active={selected}
            role="tab"
            id={`${idPrefix}-${segment.value}`}
            aria-selected={selected}
            // Only the selected tab is in the tab order; the arrows move between
            // them, which is the other half of the same contract.
            tabIndex={selected ? 0 : -1}
            onPress={() => onChange(segment.value)}
            // `SegmentedButton` puts `aria-pressed` on every pill for web, which
            // is right for a button and invalid on a tab — `aria-selected` above
            // says the same thing in the tab's own vocabulary. `aria-controls`
            // only when the panel exists: the caller renders the selected one and
            // nothing else, so pointing the other tab at an id that is not in the
            // document is a promise to a screen reader the app cannot keep.
            {...({
              'aria-pressed': undefined,
              'aria-controls': selected ? `${idPrefix}-${segment.value}-panel` : undefined,
            } as object)}
            className={cn(
              'flex-row items-center gap-1.5 px-3 py-1',
              // A tab reads as the page it opens, not as a primary action, so the
              // selected pill is the raised background rather than `bg-primary`.
              selected ? 'bg-background text-foreground shadow-sm' : 'hover:bg-transparent hover:text-foreground',
            )}
          >
            {Icon ? <Icon className={cn('h-4 w-4', selected ? 'text-foreground' : 'text-muted-foreground')} /> : null}
            <Text className={cn('font-medium text-sm', selected ? 'text-foreground' : 'text-muted-foreground')}>
              {segment.label}
            </Text>
          </SegmentedButton>
        );
      })}
    </View>
  );
}

/** The attributes that pair a rendered panel with the tab that selected it. */
export function segmentPanelProps(idPrefix: string, value: string) {
  return { role: 'tabpanel' as const, id: `${idPrefix}-${value}-panel`, 'aria-labelledby': `${idPrefix}-${value}` };
}
