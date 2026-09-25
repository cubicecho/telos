import {
  cloneElement,
  createContext,
  isValidElement,
  type ReactElement,
  type Ref,
  type RefObject,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { AccessibilityInfo, Platform, Pressable, Text, View } from 'react-native';
import { IconClassContext } from '@/components/ui/icons-base';
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
import { Popover, PopoverContent } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

type MenuState = {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: RefObject<View | null>;
};

const MenuContext = createContext<MenuState>({
  open: false,
  setOpen: () => {},
  triggerRef: { current: null },
});

/** Put focus back on the trigger, in whichever sense of focus the platform has. */
function returnFocus(node: View | null) {
  if (!node) return;
  if (Platform.OS === 'web') {
    (node as unknown as { focus?: () => void }).focus?.();
  } else {
    AccessibilityInfo.sendAccessibilityEvent(node, 'focus');
  }
}

function Menu({ open, onOpenChange, defaultOpen = false, children }: MenuProps) {
  // Uncontrolled state kept unconditionally and read only when the caller passed no `open`, the
  // same arrangement as `popover.tsx`.
  const [uncontrolled, setUncontrolled] = useState(defaultOpen);
  const isOpen = open ?? uncontrolled;
  const setOpen = (next: boolean) => {
    if (open === undefined) setUncontrolled(next);
    onOpenChange?.(next);
  };

  const triggerRef = useRef<View | null>(null);
  const wasOpen = useRef(isOpen);
  useEffect(() => {
    // On the close edge only, however it closed: a row, the backdrop or the back button.
    if (wasOpen.current && !isOpen) returnFocus(triggerRef.current);
    wasOpen.current = isOpen;
  }, [isOpen]);

  return (
    <MenuContext.Provider value={{ open: isOpen, setOpen, triggerRef }}>
      <Popover open={isOpen} onOpenChange={setOpen}>
        {children}
      </Popover>
    </MenuContext.Provider>
  );
}

function MenuTrigger({ asChild, children }: MenuTriggerProps) {
  const { open, setOpen, triggerRef } = useContext(MenuContext);
  if (asChild && isValidElement(children)) {
    // The child's own ref still gets the node; the menu only needs to read it too.
    const own = (children.props as { ref?: Ref<View> }).ref;
    return cloneElement(
      children as ReactElement<{
        onPress?: () => void;
        ref?: Ref<View>;
        'aria-expanded'?: boolean;
      }>,
      {
        onPress: () => setOpen(true),
        'aria-expanded': open,
        ref: (node: View | null) => {
          triggerRef.current = node;
          if (typeof own === 'function') own(node);
          else if (own) own.current = node;
        },
      },
    );
  }
  return (
    // The `role` is hand-written because a `<button>` has no native counterpart.
    <Pressable role="button" aria-expanded={open} ref={triggerRef} onPress={() => setOpen(true)}>
      {children}
    </Pressable>
  );
}

function MenuContent({ className, 'aria-label': ariaLabel, children }: MenuContentProps) {
  return (
    <PopoverContent className={cn(MENU_CONTENT_CLASS, 'w-64', className)}>
      <View role="menu" aria-label={ariaLabel}>
        {children}
      </View>
    </PopoverContent>
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
}: MenuItemProps) {
  const { setOpen } = useContext(MenuContext);
  const ink = destructive ? 'text-destructive' : 'text-popover-foreground';
  return (
    <Pressable
      role="menuitem"
      disabled={disabled}
      aria-disabled={disabled}
      onPress={() => {
        onSelect?.();
        setOpen(false);
      }}
      className={cn(
        MENU_ITEM_CLASS,
        destructive ? 'active:bg-destructive/10' : 'active:bg-accent',
        disabled && 'opacity-50',
        className,
      )}
    >
      {/* Colour does not inherit on native, so the row's ink reaches the icon through the
          context and the label through its own class. */}
      <IconClassContext.Provider value={cn('size-4 shrink-0', ink)}>
        {icon}
        <Text numberOfLines={1} className={cn(MENU_ITEM_TEXT_CLASS, ink)}>
          {label}
        </Text>
        {typeof trailing === 'string' ? <Text className={MENU_TRAILING_CLASS}>{trailing}</Text> : trailing}
      </IconClassContext.Provider>
    </Pressable>
  );
}

function MenuSeparator({ className }: MenuSeparatorProps) {
  return <View role="separator" className={cn(MENU_SEPARATOR_CLASS, className)} />;
}

export { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger };
