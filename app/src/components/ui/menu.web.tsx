import { DropdownMenu as MenuPrimitive } from 'radix-ui';
import type * as React from 'react';
import {
  MENU_CONTENT_CLASS,
  MENU_ITEM_CLASS,
  MENU_ITEM_TEXT_CLASS,
  MENU_SEPARATOR_CLASS,
  MENU_TRAILING_CLASS,
  type MenuContentProps,
  type MenuItemProps,
  type MenuProps,
  type MenuSeparatorProps,
  type MenuTriggerProps,
} from '@/components/ui/menu-base';
import { cn } from '@/lib/utils';

/** The shared contract, widened to what the radix part underneath accepts. */
type Wide<Base, Radix> = Base & Omit<Radix, keyof Base>;

function Menu({
  open,
  onOpenChange,
  defaultOpen,
  ...props
}: Wide<MenuProps, React.ComponentProps<typeof MenuPrimitive.Root>>) {
  // Spread rather than passed: radix switches to uncontrolled only when `open` is absent, and an
  // explicit `undefined` is not absent.
  return (
    <MenuPrimitive.Root
      data-slot="menu"
      {...props}
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange === undefined ? {} : { onOpenChange })}
      {...(defaultOpen === undefined ? {} : { defaultOpen })}
    />
  );
}

function MenuTrigger({
  asChild,
  ...props
}: Wide<MenuTriggerProps, React.ComponentProps<typeof MenuPrimitive.Trigger>>) {
  return <MenuPrimitive.Trigger data-slot="menu-trigger" asChild={asChild ?? false} {...props} />;
}

function MenuContent({
  className,
  align = 'center',
  sideOffset = 4,
  ...props
}: Wide<MenuContentProps, React.ComponentProps<typeof MenuPrimitive.Content>>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        data-slot="menu-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          MENU_CONTENT_CLASS,
          'z-50 max-h-(--radix-dropdown-menu-content-available-height) origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

function MenuItem({
  icon,
  label,
  trailing,
  destructive = false,
  disabled = false,
  onSelect,
  className,
  ...props
}: Wide<MenuItemProps, Omit<React.ComponentProps<typeof MenuPrimitive.Item>, 'children'>>) {
  return (
    <MenuPrimitive.Item
      data-slot="menu-item"
      data-variant={destructive ? 'destructive' : 'default'}
      disabled={disabled}
      textValue={label}
      {...props}
      onSelect={() => onSelect?.()}
      // Icons inherit `currentColor` here, so the row's text colour is the icon's too — the web
      // half of what `IconClassContext` does on native.
      className={cn(
        MENU_ITEM_CLASS,
        'relative flex cursor-default select-none outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
        destructive
          ? 'text-destructive focus:bg-destructive/10 focus:text-destructive'
          : 'text-popover-foreground focus:bg-accent focus:text-accent-foreground',
        className,
      )}
    >
      {icon}
      <span className={cn(MENU_ITEM_TEXT_CLASS, 'truncate')}>{label}</span>
      {typeof trailing === 'string' ? (
        <span className={cn(MENU_TRAILING_CLASS, 'tracking-widest')}>{trailing}</span>
      ) : (
        trailing
      )}
    </MenuPrimitive.Item>
  );
}

function MenuSeparator({
  className,
  ...props
}: Wide<MenuSeparatorProps, React.ComponentProps<typeof MenuPrimitive.Separator>>) {
  return (
    <MenuPrimitive.Separator
      data-slot="menu-separator"
      className={cn(MENU_SEPARATOR_CLASS, 'pointer-events-none', className)}
      {...props}
    />
  );
}

export { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger };
