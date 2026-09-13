import * as Popover from '@radix-ui/react-popover';
import { ArrowDownWideNarrow, Check, Search, Tag, X } from 'lucide-react';
import { forwardRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  children: React.ReactNode;
}) {
  return (
    <Popover.Close asChild>
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
      >
        {children}
        {selected ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
      </button>
    </Popover.Close>
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
  HTMLInputElement,
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

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            ref={ref}
            type="search"
            value={filter.text}
            placeholder="Filter todos…  (press /)"
            aria-label="Filter todos by title or notes"
            onChange={(event) => onChange({ ...filter, text: event.target.value })}
            className="pl-8"
          />
        </div>

        <Popover.Root>
          <Popover.Trigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={cn('gap-2', selected && 'border-ring')}
              aria-label="Filter by label"
            >
              {selected ? (
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: selected.color }} />
              ) : (
                <Tag className="h-4 w-4" />
              )}
              {selected ? selected.name : 'Label'}
            </Button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              sideOffset={6}
              align="start"
              className="z-50 w-56 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
            >
              {labels.length === 0 ? (
                <p className="px-2 py-3 text-center text-muted-foreground text-sm">
                  No labels on this project's todos.
                </p>
              ) : (
                <>
                  <LabelOption
                    onSelect={() => onChange({ ...filter, labelId: null })}
                    selected={filter.labelId === null}
                  >
                    <span className="flex-1 truncate text-muted-foreground">Any label</span>
                  </LabelOption>
                  {labels.map((label) => (
                    <LabelOption
                      key={label.id}
                      onSelect={() => onChange({ ...filter, labelId: label.id })}
                      selected={filter.labelId === label.id}
                    >
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: label.color }} />
                      <span className="flex-1 truncate">{label.name}</span>
                    </LabelOption>
                  ))}
                </>
              )}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>

        {/* Two states, so a toggle rather than a select — which is just as well,
            since the repo has no select component and this does not justify one. */}
        <Button
          variant="outline"
          size="sm"
          className={cn('gap-2', filter.sort === 'due' && 'border-ring')}
          aria-pressed={filter.sort === 'due'}
          onClick={() => onChange({ ...filter, sort: nextSort(filter.sort) })}
        >
          <ArrowDownWideNarrow className="h-4 w-4" />
          {filter.sort === 'due' ? 'By due date' : 'Manual order'}
        </Button>

        {active ? (
          <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground" onClick={() => onChange(NO_FILTER)}>
            <X className="h-4 w-4" />
            Clear
          </Button>
        ) : null}
      </div>

      {/* Only while filtering. A count on an unfiltered list is noise, but on a
          filtered one it is the difference between "this project is empty" and
          "nothing here matches what you typed". */}
      {active ? (
        <p className="text-muted-foreground text-xs" aria-live="polite">
          {matched === 0
            ? 'No todos match.'
            : `${matched} of ${todos.length} ${todos.length === 1 ? 'todo' : 'todos'}.`}
        </p>
      ) : null}
    </div>
  );
});

function nextSort(sort: TodoSort): TodoSort {
  return sort === 'due' ? 'manual' : 'due';
}
