import * as Popover from '@radix-ui/react-popover';
import { Check, Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
}: {
  todo: TodoSummary;
  candidates: readonly TodoSummary[];
  onToggle: (dependsOnTodoId: string, add: boolean) => void;
}) {
  const dependencyIds = new Set(todo.dependencies.map((dependency) => dependency.id));
  const options = candidates.filter((candidate) => candidate.id !== todo.id);

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="ghost" size="sm" className="text-muted-foreground">
          <Link2 className="mr-1 h-3.5 w-3.5" />
          {todo.dependencies.length > 0 ? `Waits on ${todo.dependencies.length}` : 'Depends on'}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={6}
          align="start"
          className="z-50 max-h-64 w-64 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {options.length === 0 ? (
            <p className="px-2 py-3 text-center text-muted-foreground text-sm">Nothing else in this project yet.</p>
          ) : (
            options.map((option) => {
              const selected = dependencyIds.has(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => onToggle(option.id, !selected)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                >
                  <span className="flex-1 truncate">{option.title}</span>
                  {option.completedAt ? <span className="text-muted-foreground text-xs">done</span> : null}
                  {selected ? <Check className="h-3.5 w-3.5" /> : null}
                </button>
              );
            })
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
