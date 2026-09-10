import { useMutation } from '@apollo/client';
import type { TodoSummary } from '@/components/domain/todo/types';
import { bumpProjectCounts, type CachedLane, updateProjectTodos } from '@/lib/cache';
import { MoveTodoDocument } from '@/lib/graphql';
import { moveTodoInList } from '@/lib/lanes';

/**
 * The one way a todo changes lane, shared by the board's drag and the row's
 * "Move to" menu so the two cannot drift apart.
 *
 * The move is written to the cache before the request leaves, including the
 * completion the destination implies — dropping a card in the done column ticks
 * it off, and dragging it out reopens it, both instantly.
 */
export function useMoveTodo(projectId: string) {
  const [moveTodo] = useMutation(MoveTodoDocument);

  return async function move(todo: TodoSummary, lane: CachedLane, index?: number): Promise<void> {
    if (todo.lane?.id === lane.id && index == null) return;
    // Said here as well as on the server: the answer is the same either way, and
    // the card should never appear to land somewhere it will bounce out of.
    if (lane.isDone && todo.isBlocked && todo.completedAt == null) {
      throw new Error(`Blocked by ${todo.blockedBy.map((blocker) => blocker.title).join(', ')}.`);
    }

    const completedAt = lane.isDone ? (todo.completedAt ?? new Date().toISOString()) : null;
    // Blocked todos count as open, so only crossing into or out of done moves
    // the number.
    const open =
      todo.completedAt == null && completedAt != null ? -1 : todo.completedAt != null && completedAt == null ? 1 : 0;

    await moveTodo({
      variables: { id: todo.id, laneId: lane.id, position: index },
      optimisticResponse: {
        moveTodo: {
          __typename: 'Todo',
          id: todo.id,
          completedAt,
          position: todo.position ?? 0,
          isBlocked: todo.isBlocked,
          lane,
        },
      },
      update(cache, { data }) {
        const moved = data?.moveTodo;
        const landed = moved?.lane;
        if (!moved || !landed) return;
        updateProjectTodos(cache, projectId, (todos) => moveTodoInList(todos, moved.id, landed, index));
        bumpProjectCounts(cache, projectId, { total: 0, open });
      },
    });
  };
}
