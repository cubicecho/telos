import { type DocumentNode, useMutation, useQuery } from '@apollo/client';
import { type ComponentProps, type ReactNode, useState } from 'react';
import { Text, View } from 'react-native';
import { ArchiveRestore } from '@/components/app-icons';
import { ConfirmButton } from '@/components/confirm-button';
import { Button } from '@/components/ui/button';
import { Trash2 } from '@/components/ui/icons';
import { LoadState } from '@/components/ui/load-failure';
import { formatTimestamp } from '@/lib/dates';
import { describeError } from '@/lib/errors';
import {
  ArchivedTodosDocument,
  DeleteTodoForGoodDocument,
  ProjectDocument,
  ProjectTodosDocument,
  RestoreTodoDocument,
} from '@/lib/graphql';

// A project's archived todos: put away rather than gone, each one a click from
// coming back, or a confirmation from being deleted for good.

interface Archived {
  id: string;
  title: string;
}

/** An archived todo as a list of them draws it. */
export interface ArchivedTodo extends Archived {
  completedAt?: string | null | undefined;
  archivedAt?: string | null | undefined;
  lane?: { name: string } | null | undefined;
  /** Its project, named only in a list across projects. */
  project?: { name: string } | null | undefined;
}

export function ArchivedTodos({ projectId }: { projectId: string }) {
  const query = useQuery(ArchivedTodosDocument, { variables: { projectId }, fetchPolicy: 'cache-and-network' });
  return (
    <ArchivedTodoList
      query={query}
      todos={query.data?.todos ?? []}
      // A restored todo lands back in the lists and the counts, so both refetch.
      onRestore={[ArchivedTodosDocument, ProjectTodosDocument, ProjectDocument]}
      onDelete={[ArchivedTodosDocument]}
    />
  );
}

/**
 * Archived todos, each with its way back and its way out: a project's, or the
 * account's. The caller reads them and says which of its queries a restore or a
 * delete leaves stale.
 */
export function ArchivedTodoList({
  query,
  todos,
  onRestore,
  onDelete,
  footer,
}: {
  query: ComponentProps<typeof LoadState>['query'];
  todos: readonly ArchivedTodo[];
  /** The queries to read again once a todo is restored. */
  onRestore: DocumentNode[];
  /** The queries to read again once a todo is deleted for good. */
  onDelete: DocumentNode[];
  /** Under the list: a way to more of it. */
  footer?: ReactNode;
}) {
  const [error, setError] = useState<string | null>(null);
  const [restoreTodo, restoreState] = useMutation(RestoreTodoDocument, { refetchQueries: onRestore });
  const [deleteForGood, deleteState] = useMutation(DeleteTodoForGoodDocument, { refetchQueries: onDelete });
  const busy = restoreState.loading || deleteState.loading;

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(describeError(caught));
    }
  }

  return (
    <View className="gap-3">
      <Text className="text-muted-foreground text-sm">
        Archived todos are out of the lists, the counts and the agents’ queues. Restore one to put it back where it was.
      </Text>
      <LoadState
        query={query}
        what="the archived todos"
        count={todos.length}
        empty={<Text className="text-muted-foreground text-sm">Nothing archived.</Text>}
      />
      {error ? <Text className="text-destructive text-sm">{error}</Text> : null}
      {todos.length > 0 ? (
        <View role="list" aria-label="Archived todos" className="gap-2">
          {todos.map((todo) => (
            <View
              key={todo.id}
              role="listitem"
              className="flex-row items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
            >
              <View className="min-w-0 flex-1 gap-0.5">
                <Text className="text-foreground text-sm">{todo.title}</Text>
                <Text className="text-muted-foreground text-xs">
                  {[
                    todo.project?.name,
                    todo.archivedAt ? `Archived ${formatTimestamp(todo.archivedAt)}` : null,
                    todo.lane?.name,
                    todo.completedAt ? 'done' : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </View>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                aria-label={`Restore ${todo.title}`}
                onPress={() => run(() => restoreTodo({ variables: { id: todo.id } }))}
              >
                <ArchiveRestore className="h-4 w-4" />
                Restore
              </Button>
              <ConfirmButton
                variant="ghost"
                size="icon-xs"
                className="hover:text-destructive"
                disabled={busy}
                label={`Delete ${todo.title} for good`}
                title="Delete this todo for good?"
                description={`“${todo.title}”, its history, notes, runs and dependency links are removed. This cannot be undone.`}
                onConfirm={() => void run(() => deleteForGood({ variables: { id: todo.id } }))}
              >
                <Trash2 className="h-4 w-4" />
              </ConfirmButton>
            </View>
          ))}
        </View>
      ) : null}
      {footer}
    </View>
  );
}
