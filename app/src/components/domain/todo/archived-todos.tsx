import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { ArchiveRestore } from '@/components/app-icons';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
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

export function ArchivedTodos({ projectId }: { projectId: string }) {
  const query = useQuery(ArchivedTodosDocument, { variables: { projectId }, fetchPolicy: 'cache-and-network' });
  const todos = query.data?.todos ?? [];
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Archived | null>(null);
  // A restored todo lands back in the lists and the counts, so both refetch.
  const [restoreTodo, restoreState] = useMutation(RestoreTodoDocument, {
    refetchQueries: [ArchivedTodosDocument, ProjectTodosDocument, ProjectDocument],
  });
  const [deleteForGood, deleteState] = useMutation(DeleteTodoForGoodDocument, {
    refetchQueries: [ArchivedTodosDocument],
  });
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
        Archived todos are out of the lists, the counts and the stations’ queues. Restore one to put it back where it
        was.
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
              <Button
                variant="ghost"
                size="icon-xs"
                className="hover:text-destructive"
                disabled={busy}
                aria-label={`Delete ${todo.title} for good`}
                onPress={() => setDeleting(todo)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </View>
          ))}
        </View>
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this todo for good?"
        description={`“${deleting?.title ?? ''}”, its history, notes, runs and dependency links are removed. This cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={() => {
          const target = deleting;
          setDeleting(null);
          if (target) void run(() => deleteForGood({ variables: { id: target.id } }));
        }}
      />
    </View>
  );
}
