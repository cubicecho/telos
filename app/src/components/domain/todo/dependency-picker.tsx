import { Text } from 'react-native';
import { MenuCheckboxItem } from '@/components/ui/menu';
import type { TodoSummary } from './types';

/**
 * Which other todos in this project the given one waits on, as rows for a
 * menu (a todo row's ⋯). Candidates exclude the todo itself; the server
 * rejects anything that would close a cycle, and that error is surfaced by the
 * caller rather than pre-empted here — the graph is the server's to know.
 */
export function DependencyMenuItems({
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

  if (options.length === 0) {
    return <Text className="px-2 py-3 text-center text-foreground/60 text-sm">Nothing else in this project yet.</Text>;
  }
  return (
    <>
      {options.map((option) => (
        <MenuCheckboxItem
          key={option.id}
          checked={dependencyIds.has(option.id)}
          onCheckedChange={(add) => onToggle(option.id, add)}
          label={option.title}
          trailing={option.completedAt ? 'done' : undefined}
        />
      ))}
    </>
  );
}
