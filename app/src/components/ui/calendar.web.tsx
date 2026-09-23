import type { CSSProperties } from 'react';
import { DayPicker, type PropsBase } from 'react-day-picker';
import type { CalendarProps } from '@/components/ui/calendar-base';
import { cn } from '@/lib/utils';
import 'react-day-picker/style.css';

/**
 * react-day-picker's colour variables, pointed at the theme tokens. Its stylesheet ships them as
 * `blue`, `#f0f0ff` and `white`, so without this the chevrons, today and the selected ring are
 * blue on every theme, dark included. The tokens are read live, so `.dark` needs nothing more.
 *
 * An inline style rather than a class, and here rather than in the `tokens` item. `style.css`
 * declares these on `.rdp-root` unlayered, and an unlayered rule beats everything in
 * `@layer utilities`, so a `[--rdp-accent-color:…]` class would lose in a DOM app. And this file
 * is what renders on both paths, a DOM app on `tokens.web.css` and an Expo web app on
 * `cubeui-tokens.css`, which define the same `--primary` and `--accent`.
 */
const THEME = {
  '--rdp-accent-color': 'var(--primary)',
  '--rdp-accent-background-color': 'var(--accent)',
  '--rdp-today-color': 'var(--primary)',
  '--rdp-range_middle-background-color': 'var(--accent)',
  '--rdp-range_middle-color': 'var(--accent-foreground)',
  '--rdp-range_start-color': 'var(--primary-foreground)',
  '--rdp-range_start-date-background-color': 'var(--primary)',
  '--rdp-range_end-color': 'var(--primary-foreground)',
  '--rdp-range_end-date-background-color': 'var(--primary)',
} as CSSProperties;

/** What `DayPicker` takes beyond the shared contract, passed through as it is. */
type DayPickerExtras = Omit<
  PropsBase,
  | 'disabled'
  | 'defaultMonth'
  | 'numberOfMonths'
  | 'startMonth'
  | 'weekStartsOn'
  | 'className'
  | 'mode'
  | 'selected'
  | 'onSelect'
  | 'required'
>;

export function Calendar(props: CalendarProps & DayPickerExtras) {
  const {
    mode: _mode,
    selected: _selected,
    onSelect: _onSelect,
    disabled,
    defaultMonth,
    numberOfMonths,
    startMonth,
    weekStartsOn,
    className,
    style,
    ...extras
  } = props;

  // Spread rather than passed: under `exactOptionalPropertyTypes` an explicit
  // `undefined` is not the same as an absent prop, and react-day-picker reads
  // several of these as "the caller set this".
  const shared = {
    ...extras,
    ...(disabled === undefined ? {} : { disabled }),
    ...(defaultMonth === undefined ? {} : { defaultMonth }),
    ...(numberOfMonths === undefined ? {} : { numberOfMonths }),
    ...(startMonth === undefined ? {} : { startMonth }),
    ...(weekStartsOn === undefined ? {} : { weekStartsOn }),
    className: cn('p-3', className),
    // The caller's style last, so a call site can still override any of them.
    style: { ...THEME, ...style },
  };

  if (props.mode === 'range') {
    return (
      <DayPicker
        mode="range"
        {...shared}
        {...(props.selected === undefined ? {} : { selected: props.selected })}
        onSelect={props.onSelect}
      />
    );
  }

  return (
    <DayPicker
      mode="single"
      {...shared}
      {...(props.selected === undefined ? {} : { selected: props.selected })}
      onSelect={props.onSelect}
    />
  );
}
