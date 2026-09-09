import type { ApolloCache } from '@apollo/client';

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
