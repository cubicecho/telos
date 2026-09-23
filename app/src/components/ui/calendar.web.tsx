import { DayPicker, type PropsBase } from 'react-day-picker';
import type { CalendarProps } from '@/components/ui/calendar-base';
import { cn } from '@/lib/utils';
import 'react-day-picker/style.css';

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
