/**
 * The contract `spinner.tsx` (native) and `spinner.web.tsx` (web) both implement.
 * Its own module because Metro resolves `./spinner` to `spinner.web.tsx` on web.
 */

export type SpinnerProps = {
  /**
   * The spinner's accessible name, announced by its `role="status"`. Say what is
   * loading when the screen has more than one thing that could be.
   */
  label?: string | undefined;
  /** Size and colour: `size-6`, `text-foreground/60`. The default is `size-4`. */
  className?: string | undefined;
};

/** The glyph's size when the call site names none, shadcn's. */
export const spinnerClass = 'size-4';

/** One turn: Tailwind's `animate-spin`, which the web half uses. */
export const SPIN_DURATION_MS = 1000;
