import type { ReactNode } from 'react';

export type MenuProps = {
  /** Both optional, together, as on `Popover`: pass neither and the menu keeps its own state. */
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  defaultOpen?: boolean | undefined;
  children: ReactNode;
};

export type MenuTriggerProps = {
  /**
   * Hand the press handler to the single child element rather than wrapping it. Always pass it
   * around a `Button`: a `Pressable` wrapping a `Button` never fires on native.
   */
  asChild?: boolean | undefined;
  children: ReactNode;
};

export type MenuContentProps = {
  className?: string | undefined;
  /** Web only — the native sheet is centred and has nothing to align to. */
  align?: 'start' | 'center' | 'end' | undefined;
  /**
   * The menu's name. On web radix names it after its trigger already; on native there is no
   * `aria-labelledby` to point at the trigger, so a trigger with no text (a ⋯ button) wants this.
   */
  'aria-label'?: string | undefined;
  children?: ReactNode;
};

export type MenuItemProps = {
  /** An icon from `@cubeui/icons`. It takes the row's colour — `text-destructive` on a destructive row. */
  icon?: ReactNode;
  /** The row's text, and what typeahead matches on the web. */
  label: string;
  /** After the label, at the far edge: a shortcut, a count, a check. A string is drawn muted. */
  trailing?: ReactNode;
  /** Draw the row in the destructive colour, for the action that deletes. */
  destructive?: boolean | undefined;
  disabled?: boolean | undefined;
  /** Runs when the row is chosen. The menu closes itself afterwards; do not close it here. */
  onSelect?: (() => void) | undefined;
  className?: string | undefined;
};

export type MenuSeparatorProps = {
  className?: string | undefined;
};

export const MENU_CONTENT_CLASS = 'min-w-[8rem] p-1';
export const MENU_ITEM_CLASS = 'w-full flex-row items-center gap-2 rounded-sm px-2 py-1.5';
export const MENU_ITEM_TEXT_CLASS = 'flex-1 text-sm';
export const MENU_TRAILING_CLASS = 'ml-auto text-xs text-muted-foreground';
export const MENU_SEPARATOR_CLASS = '-mx-1 my-1 h-px bg-border';
