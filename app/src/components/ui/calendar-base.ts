/**
 * The contract `calendar.tsx` (native) and `calendar.web.tsx` (react-day-picker)
 * both implement. Its own module because Metro resolves `./calendar` to
 * `calendar.web.tsx` on web.
 *
 * `mode` was originally left out, on the grounds that range selection had no
 * native implementation behind it and a prop that works on one platform is a
 * promise half-kept. It is in now because the implementation is in: `calendar.tsx`
 * draws and selects ranges itself. `DateRange` and `DateMatcher` are declared here
 * rather than imported from react-day-picker for the same reason — a shared type
 * cannot come from a library only one platform has.
 */

/** A start and an end. `to` is absent while the range is half-picked. */
export type DateRange = {
  from: Date | undefined;
  to?: Date | undefined;
};

/**
 * Which days a matcher covers. A subset of react-day-picker's, kept to the forms
 * that can be evaluated without the library: a day, a list of days, a closed
 * interval, an open one, or a predicate. `dayOfWeek` and the rest are not here
 * because nothing in this registry asks for them yet.
 */
export type DateMatcher =
  | Date
  | Date[]
  | { from: Date; to: Date }
  | { before: Date }
  | { after: Date }
  | ((date: Date) => boolean);

type CalendarSharedProps = {
  /** Days that cannot be chosen. Several matchers are ORed. */
  disabled?: DateMatcher | DateMatcher[] | undefined;
  /** Month shown on first render; defaults to the selected date's month. */
  defaultMonth?: Date | undefined;
  /** How many months to show at once. Defaults to 1. */
  numberOfMonths?: number | undefined;
  /** The earliest month the caller can navigate back to. */
  startMonth?: Date | undefined;
  /** 0 is Sunday. Defaults to 0. */
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | undefined;
  className?: string | undefined;
};

/**
 * Discriminated on `mode`, so `onSelect` is handed a `Date` under `"single"` and a
 * `DateRange` under `"range"` — a range calendar wired to a `Date` field is a type
 * error at the call site rather than a runtime surprise.
 */
export type CalendarProps =
  | (CalendarSharedProps & {
      mode?: 'single' | undefined;
      selected?: Date | undefined;
      onSelect: (date: Date | undefined) => void;
    })
  | (CalendarSharedProps & {
      mode: 'range';
      selected?: DateRange | undefined;
      onSelect: (range: DateRange | undefined) => void;
    });
