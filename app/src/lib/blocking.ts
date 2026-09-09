import type { ProjectTodosQuery } from '@/__generated__/graphql';

/** A todo exactly as the project list holds it in the cache. */
export type CachedTodo = ProjectTodosQuery['todos'][number];

/**
 * Rederive what blocks what, over a list the client has just changed.
 *
 * `isBlocked` and `blockedBy` are server-derived, and one todo changing moves
 * them on every todo waiting for it — so a mutation cannot patch just the row
 * it names. Rather than work out which other rows moved, this recomputes the
 * pair for the whole list from the same rule the server uses (a todo is blocked
 * while any todo it depends on is still open) after syncing every dependency
 * entry against the authoritative row. A dependency on a todo that is no longer
 * in the list went away with it, the way the FK cascade removes the link
 * server-side.
 *
 * Pure, and a no-op on a list that already agrees with itself — which is what
 * lets it run on the optimistic pass and again on the real result.
 */
export function resolveBlocking(todos: readonly CachedTodo[]): CachedTodo[] {
  const byId = new Map(todos.map((todo) => [todo.id, todo]));

  return todos.map((todo) => {
    const dependencies = todo.dependencies.flatMap((dependency) => {
      const current = byId.get(dependency.id);
      return current ? [{ ...dependency, title: current.title, completedAt: current.completedAt }] : [];
    });
    const blockers = dependencies.filter((dependency) => dependency.completedAt == null);

    return {
      ...todo,
      dependencies,
      isBlocked: blockers.length > 0,
      blockedBy: blockers.map((blocker) => ({ __typename: 'Todo' as const, id: blocker.id, title: blocker.title })),
    };
  });
}
