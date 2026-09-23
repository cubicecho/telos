import { forwardRef, type ReactNode, useId, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { ArrowDownWideNarrow, Tag } from '@/components/app-icons';
import { Button } from '@/components/ui/button';
import { ColorDot } from '@/components/ui/color-dot';
import { Check, Search, X } from '@/components/ui/icons';
import type { InputHandle } from '@/components/ui/input';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { isFiltering, labelsInUse, NO_FILTER, type TodoFilter, type TodoSort } from '@/lib/filter-todos';
import { cn } from '@/lib/utils';
import type { TodoSummary } from './types';

/** One row of the label popover, shaped like `LabelPicker`'s so the two read alike. */
function LabelOption({
  onSelect,
  selected,
  children,
}: {
  onSelect: () => void;
  selected: boolean;
  children: ReactNode;
}) {
  return (
    <Pressable
      role="radio"
      aria-checked={selected}
      onPress={onSelect}
      className="w-full flex-row items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-accent"
    >
      {children}
      {selected ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
    </Pressable>
  );
}

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
  const searchId = useId();
  // Controlled, for two reasons. cubeui's popover has no `Close` part, so
  // choosing a label has to close the list from here. And on web radix opens
  // the popover from the trigger's `onClick`, which react-native-web's
  // `Pressable` overwrites with its own press handler — so the button's
  // `onPress` has to do the opening itself. (On device the trigger replaces
  // `onPress` with its own opener, so this never runs twice.)
  const [labelsOpen, setLabelsOpen] = useState(false);

  function pickLabel(labelId: string | null) {
    onChange({ ...filter, labelId });
    setLabelsOpen(false);
  }

  return (
    <View className="gap-2">
      <View className="flex-row flex-wrap items-center gap-2">
        <View className="relative min-w-48 flex-1 justify-center">
          <Search className="pointer-events-none absolute left-2.5 z-10 h-4 w-4 text-muted-foreground" />
          {/* cubeui's `Input` takes no `aria-label`; a visually hidden label
              names it instead, which is what the placeholder says anyway. */}
          <Label htmlFor={searchId} className="sr-only">
            Filter todos by title or notes
          </Label>
          <Input
            ref={ref}
            type="search"
            id={searchId}
            value={filter.text}
            placeholder="Filter todos…  (press /)"
            onChangeText={(text) => onChange({ ...filter, text })}
            className="pl-8"
          />
        </View>

        <Popover open={labelsOpen} onOpenChange={setLabelsOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={cn('gap-2', selected && 'border-ring')}
              aria-label="Filter by label"
              onPress={() => setLabelsOpen(!labelsOpen)}
            >
              {selected ? <ColorDot color={selected.color} size="sm" /> : <Tag className="h-4 w-4" />}
              {selected ? selected.name : 'Label'}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-56 p-1">
            {labels.length === 0 ? (
              <Text className="px-2 py-3 text-center text-muted-foreground text-sm">
                No labels on this project's todos.
              </Text>
            ) : (
              <>
                <LabelOption onSelect={() => pickLabel(null)} selected={filter.labelId === null}>
                  <Text numberOfLines={1} className="flex-1 text-muted-foreground text-sm">
                    Any label
                  </Text>
                </LabelOption>
                {labels.map((label) => (
                  <LabelOption
                    key={label.id}
                    onSelect={() => pickLabel(label.id)}
                    selected={filter.labelId === label.id}
                  >
                    <ColorDot color={label.color} size="sm" />
                    <Text numberOfLines={1} className="flex-1 text-popover-foreground text-sm">
                      {label.name}
                    </Text>
                  </LabelOption>
                ))}
              </>
            )}
          </PopoverContent>
        </Popover>

        {/* Two states, so a toggle rather than a select. */}
        <Button
          variant="outline"
          size="sm"
          className={cn('gap-2', filter.sort === 'due' && 'border-ring')}
          aria-pressed={filter.sort === 'due'}
          onPress={() => onChange({ ...filter, sort: nextSort(filter.sort) })}
        >
          <ArrowDownWideNarrow className="h-4 w-4" />
          {filter.sort === 'due' ? 'By due date' : 'Manual order'}
        </Button>

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

function nextSort(sort: TodoSort): TodoSort {
  return sort === 'due' ? 'manual' : 'due';
}
