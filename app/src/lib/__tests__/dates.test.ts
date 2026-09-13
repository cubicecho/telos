import { describe, expect, it } from 'vitest';
import { daysUntil, formatDueDate, fromDateInputValue, isOverdue, parseDate, toDateInputValue } from '../dates';

// Every test pins `from` explicitly. A date helper that reads the wall clock is
// a test that passes until the day it does not, and the interesting cases here
// are precisely the ones that sit near a midnight.

/** A local-time date, so the tests say what a reader in any zone would see. */
function local(year: number, month: number, day: number, hour = 12): Date {
  return new Date(year, month - 1, day, hour);
}

const NOON = local(2026, 9, 11);

describe('parseDate', () => {
  it('answers nothing for absent or malformed input, rather than an Invalid Date', () => {
    expect(parseDate(null)).toBeUndefined();
    expect(parseDate(undefined)).toBeUndefined();
    expect(parseDate('')).toBeUndefined();
    expect(parseDate('next tuesday')).toBeUndefined();
  });

  it('parses an ISO instant', () => {
    expect(parseDate('2026-12-01T09:00:00.000Z')?.toISOString()).toBe('2026-12-01T09:00:00.000Z');
  });
});

describe('daysUntil', () => {
  it('counts calendar days, not elapsed hours', () => {
    // Two hours apart, but on either side of midnight: that is one day, and the
    // naive `(a - b) / DAY` would call it zero.
    expect(daysUntil(local(2026, 9, 12, 1), local(2026, 9, 11, 23))).toBe(1);
    // Twenty-two hours apart within one day is still zero.
    expect(daysUntil(local(2026, 9, 11, 23), local(2026, 9, 11, 1))).toBe(0);
  });

  it('counts backwards for a past date', () => {
    expect(daysUntil(local(2026, 9, 8), NOON)).toBe(-3);
  });

  it('crosses a month and a year boundary', () => {
    expect(daysUntil(local(2026, 10, 1), local(2026, 9, 30))).toBe(1);
    expect(daysUntil(local(2027, 1, 1), local(2026, 12, 31))).toBe(1);
  });

  it('crosses a DST change without drifting', () => {
    // Spring forward loses an hour, so 23 elapsed hours still has to read as one
    // day. Midnight-to-midnight arithmetic is what makes this hold in zones
    // that observe it, and is a no-op in zones that do not.
    expect(daysUntil(local(2026, 3, 9), local(2026, 3, 8))).toBe(1);
    expect(daysUntil(local(2026, 11, 2), local(2026, 11, 1))).toBe(1);
  });
});

describe('isOverdue', () => {
  it('is false all day on the due day, and true the next', () => {
    const due = local(2026, 9, 11, 9).toISOString();
    expect(isOverdue(due, local(2026, 9, 11, 23))).toBe(false);
    expect(isOverdue(due, local(2026, 9, 12, 0))).toBe(true);
  });

  it('is false for a todo with no due date', () => {
    expect(isOverdue(null, NOON)).toBe(false);
    expect(isOverdue(undefined, NOON)).toBe(false);
  });
});

describe('formatDueDate', () => {
  it('names the days either side of today', () => {
    expect(formatDueDate(local(2026, 9, 11).toISOString(), NOON)).toBe('Today');
    expect(formatDueDate(local(2026, 9, 12).toISOString(), NOON)).toBe('Tomorrow');
    expect(formatDueDate(local(2026, 9, 10).toISOString(), NOON)).toBe('Yesterday');
  });

  it('counts within a week, in both directions', () => {
    expect(formatDueDate(local(2026, 9, 14).toISOString(), NOON)).toBe('In 3 days');
    expect(formatDueDate(local(2026, 9, 8).toISOString(), NOON)).toBe('3 days ago');
    expect(formatDueDate(local(2026, 9, 18).toISOString(), NOON)).toBe('In 7 days');
    expect(formatDueDate(local(2026, 9, 4).toISOString(), NOON)).toBe('7 days ago');
  });

  it('gives the date itself past a week, where counting stops helping', () => {
    expect(formatDueDate(local(2026, 9, 19).toISOString(), NOON)).not.toMatch(/days/);
    expect(formatDueDate(local(2026, 9, 3).toISOString(), NOON)).not.toMatch(/days/);
  });

  it('states the year only when it is not this one', () => {
    expect(formatDueDate(local(2026, 12, 1).toISOString(), NOON)).not.toMatch(/2026/);
    expect(formatDueDate(local(2027, 2, 1).toISOString(), NOON)).toMatch(/2027/);
  });

  it('answers nothing for a todo with no due date', () => {
    expect(formatDueDate(null, NOON)).toBeUndefined();
    expect(formatDueDate('not a date', NOON)).toBeUndefined();
  });
});

describe('the date input round-trip', () => {
  it('gives back the local day, not the UTC one', () => {
    // Stored at 23:00 local on the 11th. Slicing the ISO string would open the
    // picker on the 12th in any zone behind UTC, disagreeing with the badge.
    const stored = local(2026, 9, 11, 23).toISOString();
    expect(toDateInputValue(stored)).toBe('2026-09-11');
  });

  it('survives a round trip through the picker', () => {
    const stored = local(2026, 9, 11, 23).toISOString();
    const round = fromDateInputValue(toDateInputValue(stored));
    expect(round).not.toBeNull();
    expect(toDateInputValue(round)).toBe('2026-09-11');
  });

  it('reads an empty field as no due date', () => {
    expect(toDateInputValue(null)).toBe('');
    expect(toDateInputValue('not a date')).toBe('');
    expect(fromDateInputValue('')).toBeNull();
    expect(fromDateInputValue('not a date')).toBeNull();
  });

  it('pads single-digit months and days', () => {
    expect(toDateInputValue(local(2026, 1, 5).toISOString())).toBe('2026-01-05');
  });
});
