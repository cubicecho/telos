import { useMutation } from '@apollo/client';
import { bumpProjectCounts, type CachedLane, laneForCompletion, updateProjectTodos } from '@/lib/cache';
import { CreateTodoDocument } from '@/lib/graphql';
import { newId } from '@/lib/ids';

/**
 * Adding a todo from a title, written to the cache before the request leaves
 * from an id minted here. Apollo replaces that entry with the server's when it
 * answers and rolls it back if the write fails.
 *
 * With a lane, the todo goes there; into the done lane, it is created done,
 * since the server puts a todo wherever its completion says it belongs.
 * Without one, it is open and lands in the first open lane.
 */
export function useCreateTodo(projectId: string, lanes: readonly CachedLane[]) {
  const [createTodo, { error }] = useMutation(CreateTodoDocument);

  async function create(title: string, position: number, lane?: CachedLane) {
    const id = newId();
    const completedAt = lane?.isDone ? new Date().toISOString() : null;
    await createTodo({
      variables: {
        values: {
          id,
          projectId,
          title,
          position,
          ...(lane ? { laneId: lane.id } : {}),
          ...(completedAt ? { completedAt } : {}),
        },
      },
      // A new todo is unblocked and bare — every field the list reads is known
      // here, so nothing about this row is a guess except that it will be
      // accepted.
      optimisticResponse: {
        createTodo: {
          __typename: 'Todo',
          id,
          title,
          // Only a title is taken here; both are set from the edit dialog.
          notes: null,
          acceptance: null,
          aiIgnored: false,
          parentId: null,
          dueAt: null,
          completedAt,
          position,
          isBlocked: false,
          blockedBy: [],
          dependencies: [],
          labels: [],
          // The same lane the server's realignment will put it in.
          lane: lane ?? laneForCompletion(lanes, null),
        },
      },
      update(cache, { data }) {
        const todo = data?.createTodo;
        if (!todo) return;
        // Filtered before appending: the list may already hold this id if a
        // refetch landed first, and the query orders by position, so the end
        // is where a todo with the highest one belongs.
        updateProjectTodos(cache, projectId, (todos) => [...todos.filter((row) => row.id !== todo.id), todo]);
        bumpProjectCounts(cache, projectId, { total: 1, open: completedAt ? 0 : 1 });
      },
    });
  }

  return { create, error };
}
