/**
 * Due dates, as a reader wants to see them.
 *
 * No date library, deliberately: the whole of what this app does with a date is
 * say how far off it is and print it short, and `Intl` does both without adding
 * a dependency the rest of the repo does not have. `readable-text-color.ts` is
 * the precedent — a pure, dependency-free, unit-tested formatting module.
 *
 * Everything here takes the ISO string the cache holds, because `app/codegen.ts`
 * maps `DateTime` to `string` on purpose: nothing in the client needs a `Date`
 * except the code that is about to format one.
 */

/** Milliseconds in a day. Every comparison here is in whole local days. */
const DAY = 86_400_000;

const SHORT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const WITH_YEAR = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: 'full' });

/** A date parsed, or nothing — so a malformed value renders as absent rather than as "Invalid Date". */
export function parseDate(iso: string | null | undefined): Date | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Whole days from `from` to `date`, counted between local midnights.
 *
 * Midnight-to-midnight rather than `(a - b) / DAY`, because "tomorrow" means the
 * next calendar day however few hours away it is: 11pm to 1am is one day, not
 * zero, and an hour before midnight on a Sunday is still "yesterday" by Monday
 * morning. Taking the floor of a raw difference gets both of those wrong.
 */
export function daysUntil(date: Date, from: Date = new Date()): number {
  const midnight = (at: Date) => new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  return Math.round((midnight(date) - midnight(from)) / DAY);
}

/** True when the date is before today, by whole local days — so an overdue todo is overdue all day. */
export function isOverdue(iso: string | null | undefined, from: Date = new Date()): boolean {
  const date = parseDate(iso);
  return date !== undefined && daysUntil(date, from) < 0;
}

/**
 * A due date in as few characters as say it: "Today", "Tomorrow", "3 days ago",
 * else a short date, with the year only when it is not this one.
 *
 * The named days stop at a week out in either direction. Past that, "in 23 days"
 * is worse than the date itself — the reader wants to know *when*, and counting
 * is their job at that distance, not the badge's.
 */
export function formatDueDate(iso: string | null | undefined, from: Date = new Date()): string | undefined {
  const date = parseDate(iso);
  if (!date) return undefined;

  const days = daysUntil(date, from);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  if (days > 1 && days <= 7) return `In ${days} days`;
  if (days < -1 && days >= -7) return `${-days} days ago`;

  return date.getFullYear() === from.getFullYear() ? SHORT.format(date) : WITH_YEAR.format(date);
}

/** The unabbreviated date, for the `title` of a badge whose text is relative. */
export function formatDueDateLong(iso: string | null | undefined): string | undefined {
  const date = parseDate(iso);
  return date && FULL.format(date);
}

/**
 * An ISO instant as `yyyy-mm-dd` in the *local* zone, which is what
 * `<input type="date">` reads and writes.
 *
 * Not `toISOString().slice(0, 10)`: that is the UTC day, so a due date stored at
 * 23:00 local would open the picker on the day after the one the badge shows.
 */
export function toDateInputValue(iso: string | null | undefined): string {
  const date = parseDate(iso);
  if (!date) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * A `yyyy-mm-dd` from the date picker as the ISO instant the server stores, or
 * null for a cleared field.
 *
 * Local midnight rather than UTC midnight, for the same reason as above: the day
 * the user picked is the day they must get back, in their own zone.
 */
export function fromDateInputValue(value: string): string | null {
  if (!value) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
