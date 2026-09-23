import { createContext, useContext, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  TABS_LIST_CLASS,
  TABS_TRIGGER_CLASS,
  TABS_TRIGGER_TEXT_CLASS,
  type TabsContentProps,
  type TabsListProps,
  type TabsProps,
  type TabsTriggerProps,
} from '@/components/ui/tabs-base';
import { cn } from '@/lib/utils';

type TabsState = { value: string; setValue: (value: string) => void };

const TabsContext = createContext<TabsState>({ value: '', setValue: () => {} });

function Tabs({ value: controlled, onValueChange, defaultValue, className, children }: TabsProps) {
  const [uncontrolled, setUncontrolled] = useState(defaultValue ?? '');
  const value = controlled ?? uncontrolled;
  const setValue = (next: string) => {
    if (controlled === undefined) setUncontrolled(next);
    onValueChange?.(next);
  };
  return (
    <TabsContext.Provider value={{ value, setValue }}>
      <View className={cn(className)}>{children}</View>
    </TabsContext.Provider>
  );
}

function TabsList({ className, children }: TabsListProps) {
  return <View className={cn('flex-row', TABS_LIST_CLASS, className)}>{children}</View>;
}

function TabsTrigger({ value, disabled = false, className, children }: TabsTriggerProps) {
  const tabs = useContext(TabsContext);
  const active = tabs.value === value;
  return (
    <Pressable
      role="tab"
      aria-selected={active}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={() => tabs.setValue(value)}
      className={cn(TABS_TRIGGER_CLASS, active && 'bg-background', disabled && 'opacity-50', className)}
    >
      {/* Text colour does not inherit on native, so the active/inactive split
          has to land on the `<Text>` rather than on the container. */}
      <Text className={cn(TABS_TRIGGER_TEXT_CLASS, active ? 'text-foreground' : 'text-muted-foreground')}>
        {children}
      </Text>
    </Pressable>
  );
}

function TabsContent({ value, className, children }: TabsContentProps) {
  const tabs = useContext(TabsContext);
  if (tabs.value !== value) return null;
  return <View className={cn('mt-2', className)}>{children}</View>;
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
