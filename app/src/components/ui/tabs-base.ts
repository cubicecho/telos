import type { ReactNode } from 'react';

export type TabsProps = {
  /** The active tab, when the caller owns it. */
  value?: string | undefined;
  /** Called with the tab the user picked. */
  onValueChange?: ((value: string) => void) | undefined;
  /** The tab active at mount, when uncontrolled. */
  defaultValue?: string | undefined;
  className?: string | undefined;
  children: ReactNode;
};

export type TabsListProps = {
  className?: string | undefined;
  children: ReactNode;
};

export type TabsTriggerProps = {
  value: string;
  /** Not selectable, and dimmed. */
  disabled?: boolean | undefined;
  className?: string | undefined;
  children: ReactNode;
};

export type TabsContentProps = {
  value: string;
  className?: string | undefined;
  children: ReactNode;
};

export const TABS_LIST_CLASS = 'h-10 items-center justify-center rounded-md bg-muted p-1';
export const TABS_TRIGGER_CLASS = 'items-center justify-center rounded-sm px-3 py-1.5';
export const TABS_TRIGGER_TEXT_CLASS = 'text-sm font-medium';
