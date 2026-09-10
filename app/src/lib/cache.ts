import type { ApolloCache } from '@apollo/client';
import type { ProjectLanesQuery } from '@/__generated__/graphql';
import { type CachedTodo, resolveBlocking } from './blocking';
import { ProjectLanesDocument, ProjectTodosDocument } from './graphql';

/** A lane exactly as the board holds it in the cache. */
export type CachedLane = ProjectLanesQuery['lanes'][number];

/**
 * Move a project's todo counts without asking the server for them.
 *
 * `Project` is a normalized entity, so the sidebar's copy and the project
 * header's copy are one object in the cache: a single `modify` moves both
 * numbers everywhere they appear. The counts are the only thing a write to the
 * todo list changes about a project, and the client already knows which way
 * they went, so refetching two queries to learn it is a round trip spent on
 * arithmetic.
 *
 * A no-op when the project is not in the cache — `identify` returns undefined
 * and `modify` has nothing to change, which is the right answer for a screen
 * that was never opened.
 */
export function bumpProjectCounts(
  cache: ApolloCache<unknown>,
  projectId: string,
  delta: { total: number; open: number },
): void {
  cache.modify({
    id: cache.identify({ __typename: 'Project', id: projectId }),
    fields: {
      todoCount: (value: number) => value + delta.total,
      openTodoCount: (value: number) => value + delta.open,
    },
  });
}

/**
 * Rewrite a project's todo list in place, then settle the blocking fields.
 *
 * Every write to the list goes through here so that no caller has to remember
 * that changing one todo can unblock another. `change` states the one thing the
 * mutation actually did — add this row, drop that one, tick this one off — and
 * `resolveBlocking` works out the rest.
 *
 * A no-op when the list is not in the cache, which is the case for a project
 * the user has not opened this session.
 */
export function updateProjectTodos(
  cache: ApolloCache<unknown>,
  projectId: string,
  change: (todos: readonly CachedTodo[]) => CachedTodo[],
): void {
  cache.updateQuery({ query: ProjectTodosDocument, variables: { projectId } }, (existing) =>
    existing ? { ...existing, todos: resolveBlocking(change(existing.todos)) } : existing,
  );
}

/**
 * Rewrite a project's board in place.
 *
 * The board is a plain ordered list — nothing derives from it the way blocking
 * derives from the todo list — so this is `updateProjectTodos` without the
 * settling step, and exists for the same reason: one place that knows which
 * query holds the lanes.
 */
export function updateProjectLanes(
  cache: ApolloCache<unknown>,
  projectId: string,
  change: (lanes: readonly CachedLane[]) => CachedLane[],
): void {
  cache.updateQuery({ query: ProjectLanesDocument, variables: { projectId } }, (existing) =>
    existing ? { ...existing, lanes: change(existing.lanes) } : existing,
  );
}

/**
 * Where a todo lands when its completion changes — the same choice the server
 * makes, so an optimistic tick puts the card in the column the refresh will.
 *
 * Null when the project has no lane of the kind needed, which is also what the
 * server does: there is nowhere better to put the todo than where it is.
 */
export function laneForCompletion(lanes: readonly CachedLane[], completedAt: string | null): CachedLane | null {
  return lanes.find((lane) => lane.isDone === (completedAt != null)) ?? null;
}
