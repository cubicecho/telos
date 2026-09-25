import { forwardRef } from 'react';
import { Text, View } from 'react-native';
import { Tag } from '@/components/app-icons';
import { Button } from '@/components/ui/button';
import { ColorDot } from '@/components/ui/color-dot';
import { Check, Search, X } from '@/components/ui/icons';
import type { InputHandle } from '@/components/ui/input';
import { Input } from '@/components/ui/input';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import { SegmentedButton, SegmentedGroup } from '@/components/ui/segmented';
import { isFiltering, labelsInUse, NO_FILTER, type TodoFilter } from '@/lib/filter-todos';
import { cn } from '@/lib/utils';
import type { TodoSummary } from './types';

/**
 * Finding a todo, which until now meant reading down the page.
 *
 * The three controls are the three questions a list this size raises — what is
 * it called, what is it tagged, and what is due first — and no more than that:
 * lane and completion already have their own groupings on the screen, so
 * repeating them here would be two ways to ask one question.
 *
 * The filter offers only labels in use in *this* project. Every label in the
 * account would be a longer list that mostly narrows to nothing.
 *
 * The ref goes to the text field, so `/` can focus it from anywhere.
 */
export const TodoFilterBar = forwardRef<
  InputHandle,
  {
    filter: TodoFilter;
    onChange: (filter: TodoFilter) => void;
    todos: readonly TodoSummary[];
    /** How many survived the filter, so an empty result reads as filtered rather than empty. */
    matched: number;
  }
>(function TodoFilterBar({ filter, onChange, todos, matched }, ref) {
  const labels = labelsInUse(todos);
  const active = isFiltering(filter);
  const selected = labels.find((label) => label.id === filter.labelId);
  const pickLabel = (labelId: string | null) => onChange({ ...filter, labelId });
  const tick = (on: boolean) => (on ? <Check className="h-3.5 w-3.5" /> : null);

  return (
    <View className="gap-2">
      <View className="flex-row flex-wrap items-center gap-2">
        <View className="relative min-w-48 flex-1 justify-center">
          <Search className="pointer-events-none absolute left-2.5 z-10 h-4 w-4 text-muted-foreground" />
          <Input
            ref={ref}
            type="search"
            aria-label="Filter todos by title or notes"
            value={filter.text}
            placeholder="Filter todos…  (press /)"
            onChangeText={(text) => onChange({ ...filter, text })}
            className="pl-8"
          />
        </View>

        {/* One of N, and the menu closes on the pick. */}
        <Menu>
          <MenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={cn('gap-2', selected && 'border-ring')}
              aria-label="Filter by label"
            >
              {selected ? <ColorDot color={selected.color} size="sm" /> : <Tag className="h-4 w-4" />}
              {selected ? selected.name : 'Label'}
            </Button>
          </MenuTrigger>
          <MenuContent align="start" className="w-56">
            {labels.length === 0 ? (
              <Text className="px-2 py-3 text-center text-muted-foreground text-sm">
                No labels on this project's todos.
              </Text>
            ) : (
              <>
                <MenuItem label="Any label" onSelect={() => pickLabel(null)} trailing={tick(filter.labelId === null)} />
                <MenuSeparator />
                {labels.map((label) => (
                  <MenuItem
                    key={label.id}
                    icon={<ColorDot color={label.color} size="sm" />}
                    label={label.name}
                    onSelect={() => pickLabel(label.id)}
                    trailing={tick(filter.labelId === label.id)}
                  />
                ))}
              </>
            )}
          </MenuContent>
        </Menu>

        <SegmentedGroup
          aria-label="Sort"
          value={filter.sort}
          onValueChange={(sort) => onChange({ ...filter, sort: sort === 'due' ? 'due' : 'manual' })}
        >
          <SegmentedButton value="manual">Manual order</SegmentedButton>
          <SegmentedButton value="due">By due date</SegmentedButton>
        </SegmentedGroup>

        {active ? (
          <Button variant="ghost" size="sm" className="gap-2" onPress={() => onChange(NO_FILTER)}>
            <X className="h-4 w-4" />
            Clear
          </Button>
        ) : null}
      </View>

      {/* Only while filtering. A count on an unfiltered list is noise, but on a
          filtered one it is the difference between "this project is empty" and
          "nothing here matches what you typed". */}
      {active ? (
        <Text className="text-muted-foreground text-xs" aria-live="polite">
          {matched === 0
            ? 'No todos match.'
            : `${matched} of ${todos.length} ${todos.length === 1 ? 'todo' : 'todos'}.`}
        </Text>
      ) : null}
    </View>
  );
});
