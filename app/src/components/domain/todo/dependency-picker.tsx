import { useState } from 'react';
import { Pressable, Text } from 'react-native';
import { Link2 } from '@/components/app-icons';
import { Button } from '@/components/ui/button';
import { Check } from '@/components/ui/icons';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { TodoSummary } from './types';

/**
 * Which other todos in this project the given one waits on. Candidates exclude
 * the todo itself; the server rejects anything that would close a cycle, and
 * that error is surfaced by the caller rather than pre-empted here — the graph
 * is the server's to know.
 */
export function DependencyPicker({
  todo,
  candidates,
  onToggle,
  align = 'start',
  className,
}: {
  todo: TodoSummary;
  candidates: readonly TodoSummary[];
  onToggle: (dependsOnTodoId: string, add: boolean) => void;
  align?: 'start' | 'end';
  className?: string;
}) {
  const dependencyIds = new Set(todo.dependencies.map((dependency) => dependency.id));
  const options = candidates.filter((candidate) => candidate.id !== todo.id);
  const waiting = todo.dependencies.length;
  // Controlled only so the trigger's `onPress` can open it: on web radix opens
  // from `onClick`, which react-native-web's `Pressable` overwrites. See
  // `TodoFilterBar`.
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* Icon only. The count the label used to carry survives in the
            accessible name and as a lit icon — a todo that waits on something
            should not look identical to one that waits on nothing. */}
        <Button
          variant="ghost"
          size="icon"
          className={className}
          aria-label={waiting > 0 ? `Dependencies, waiting on ${waiting}` : 'Dependencies'}
          onPress={() => setOpen(!open)}
        >
          <Link2 className={cn('h-4 w-4', waiting > 0 ? 'text-foreground' : 'text-muted-foreground')} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align={align} className="max-h-64 w-64 overflow-y-auto p-1">
        {options.length === 0 ? (
          <Text className="px-2 py-3 text-center text-muted-foreground text-sm">Nothing else in this project yet.</Text>
        ) : (
          options.map((option) => {
            const selected = dependencyIds.has(option.id);
            return (
              <Pressable
                key={option.id}
                role="checkbox"
                aria-checked={selected}
                onPress={() => onToggle(option.id, !selected)}
                className="w-full flex-row items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-accent"
              >
                <Text numberOfLines={1} className="flex-1 text-popover-foreground text-sm">
                  {option.title}
                </Text>
                {option.completedAt ? <Text className="text-muted-foreground text-xs">done</Text> : null}
                {selected ? <Check className="h-3.5 w-3.5" /> : null}
              </Pressable>
            );
          })
        )}
      </PopoverContent>
    </Popover>
  );
}
