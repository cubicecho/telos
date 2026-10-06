import { Text } from 'react-native';
import { Link2 } from '@/components/app-icons';
import { Button } from '@/components/ui/button';
import { Menu, MenuCheckboxItem, MenuContent, MenuTrigger } from '@/components/ui/menu';
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
  size = 'icon',
  className,
}: {
  todo: TodoSummary;
  candidates: readonly TodoSummary[];
  onToggle: (dependsOnTodoId: string, add: boolean) => void;
  align?: 'start' | 'end';
  /** The trigger's square, from `Button`'s icon ladder. */
  size?: 'icon' | 'icon-sm' | 'icon-xs';
  className?: string;
}) {
  const dependencyIds = new Set(todo.dependencies.map((dependency) => dependency.id));
  const options = candidates.filter((candidate) => candidate.id !== todo.id);
  const waiting = todo.dependencies.length;

  return (
    <Menu>
      <MenuTrigger asChild>
        {/* Icon only. The count the label used to carry survives in the
            accessible name and as a lit icon — a todo that waits on something
            should not look identical to one that waits on nothing. */}
        <Button
          variant="ghost"
          size={size}
          className={className}
          aria-label={waiting > 0 ? `Dependencies, waiting on ${waiting}` : 'Dependencies'}
          iconSlot={<Link2 className={cn('h-4 w-4', waiting > 0 ? 'text-foreground' : 'text-muted-foreground')} />}
        />
      </MenuTrigger>
      <MenuContent align={align} aria-label="Dependencies" className="max-h-64 w-64 overflow-y-auto">
        {options.length === 0 ? (
          <Text className="px-2 py-3 text-center text-muted-foreground text-sm">Nothing else in this project yet.</Text>
        ) : (
          options.map((option) => {
            const selected = dependencyIds.has(option.id);
            return (
              <MenuCheckboxItem
                key={option.id}
                checked={selected}
                onCheckedChange={(add) => onToggle(option.id, add)}
                label={option.title}
                trailing={option.completedAt ? 'done' : undefined}
              />
            );
          })
        )}
      </MenuContent>
    </Menu>
  );
}
