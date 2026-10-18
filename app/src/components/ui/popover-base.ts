/**
 * The contract `popover.tsx` (native) and `popover.web.tsx` (radix) both
 * implement. Its own module for the usual reason: Metro resolves `./popover`
 * to `popover.web.tsx` on web, so the web file cannot import shared types from
 * `./popover` without importing itself.
 *
 * Narrower than radix's props on purpose: an `asChild` trigger and one content
 * pane. That is the shape both platforms can honour — everything radix offers
 * beyond it (collision handling, side flipping, a separate anchor) has no native
 * counterpart. The web half accepts it all the same, on top of this contract,
 * because it is a drop-in for shadcn's `popover`: `popover.web.tsx` widens each
 * part to the radix part it renders. Those extras are web only, and on native a
 * `PopoverAnchor` simply renders its children.
 */
import type { ReactNode } from 'react';

export type PopoverProps = {
  /**
   * Both optional, together: pass neither and the popover keeps its own open
   * state. `form-field` opens a hint popover from a trigger and never reads the
   * state back, and requiring the pair there meant a `useState` at every call
   * site that existed only to be handed straight back.
   */
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  defaultOpen?: boolean | undefined;
  children: ReactNode;
};

export type PopoverTriggerProps = {
  /**
   * Hand the press handler to the single child element rather than wrapping it.
   * Always pass it: a `Pressable` wrapping a `Button` never fires on native,
   * because the inner pressable claims the touch responder.
   */
  asChild?: boolean | undefined;
  children: ReactNode;
};

export type PopoverContentProps = {
  className?: string | undefined;
  /** Web only — the native sheet is centred and has nothing to align to. */
  align?: 'start' | 'center' | 'end' | undefined;
  /**
   * Web only — the pane's name. Radix draws the web pane as `role="dialog"`, and a dialog with no
   * name is a failure every axe run reports. A name *on* the pane rather than an
   * `aria-labelledby` pointing out of it, because a reference out of a portal resolves to nothing
   * the moment what it points at is hidden or re-keyed. The native sheet is a `Modal`, which takes
   * no name, and a label on a plain `View` inside it is one axe flags on a generic element.
   */
  'aria-label'?: string | undefined;
  children?: ReactNode;
};

/**
 * Closes the popover it is inside. `asChild` hands the press to a `Button` rather than wrapping
 * it — the same shape as `DialogClose`, so a pane's Done button does not need the caller to own
 * `open` just to set it back to `false`.
 */
export type PopoverCloseProps = {
  asChild?: boolean | undefined;
  className?: string | undefined;
  children?: ReactNode;
};

/** Web only in effect: the native sheet is centred, so it renders its children and anchors nothing. */
export type PopoverAnchorProps = {
  asChild?: boolean | undefined;
  children?: ReactNode;
};

/** `PopoverHeader`, `PopoverTitle` and `PopoverDescription` — shadcn's heading block for a pane. */
export type PopoverSectionProps = {
  className?: string | undefined;
  children?: ReactNode;
};

/** The pane's card. */
export const POPOVER_CONTENT_CLASS = 'w-72 rounded-md border border-foreground/10 bg-secondary p-4 shadow-md';
/** The block holding the title and the description. */
export const POPOVER_HEADER_CLASS = 'gap-1';
/** The pane's title. */
export const POPOVER_TITLE_CLASS = 'text-sm font-semibold text-foreground';
/** The sentence under the title. */
export const POPOVER_DESCRIPTION_CLASS = 'text-sm text-foreground/60';
