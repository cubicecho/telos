/**
 * What a number box holds while it is being typed in, for the two form bindings.
 *
 * Storing `Number(text)` on every keystroke and drawing the stored number back makes `1.`
 * unreachable: the store holds `1`, the box is redrawn as `"1"`, and the point is gone before the
 * next digit. So a number field keeps what was typed as a draft, and these two functions say what
 * the draft means and when it is still the thing to draw.
 */

/**
 * What a number box says, as a number, or nothing for empty and for the half-typed states a
 * person passes through on the way to one.
 *
 * `""`, `"-"` and `"1e"` are "not a number yet", not zero and not `NaN`: coercing them would make
 * the store say `0` while the box says `-`, and let a required-field validator pass on an empty
 * box. `Infinity` is refused with them, because a text box will take the word and no form means it.
 *
 * With `integer`, a fraction is refused the same way rather than rounded: `1.5` and `1e-3` store
 * `null`, so a validator reports the box instead of the form quietly saving a number nobody typed.
 *
 * @param text - The box's text, as typed.
 * @param integer - Whether only a whole number counts.
 * @returns The number it spells, or `null` when it does not spell a finite one (or a whole one).
 */
export function parseNumber(text: string, integer = false): number | null {
  const trimmed = text.trim();
  if (trimmed === '') {
    return null;
  }
  const parsed = Number(trimmed);
  if (integer) {
    return Number.isInteger(parsed) ? parsed : null;
  }
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The text a number box draws: the draft while it still means the stored number, the stored number
 * otherwise.
 *
 * The second half is what lets a value replaced from outside win. After a `form.reset()` or a
 * `setFieldValue` the draft no longer parses to what is stored, so it is dropped without anyone
 * having to clear it.
 *
 * @param draft - What was last typed, or `undefined` when the box is not being typed in.
 * @param stored - The number the form holds, `null` for none.
 * @param integer - Whether the box takes only whole numbers, as {@link parseNumber} reads it.
 * @returns The text for the box's `value`.
 */
export function numberText(draft: string | undefined, stored: number | null, integer = false): string {
  // `String`, not the raw number: `TextInput` takes only a string, so `Input` does on both halves.
  const storedText = stored === null ? '' : String(stored);
  if (draft !== undefined && parseNumber(draft, integer) === stored) {
    return draft;
  }
  return storedText;
}
