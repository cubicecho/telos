/**
 * The text a validator's error shows, or nothing when there is no error.
 *
 * A validator may yield a string, a `{ message }`, or something else entirely: a standard-schema
 * issue, a thrown value. This narrows and then falls back to `String`, because showing the wrong
 * text beats showing none.
 */
export function messageOf(error: unknown): string | undefined {
  if (error == null) {
    return undefined;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (typeof error === 'object' && 'message' in error) {
    return String(error.message);
  }
  return String(error);
}
