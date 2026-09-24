import type { ComponentProps } from 'react';
import { QueryError, QueryState } from '@/components/query-state';
import { describeError } from '@/lib/errors';

/**
 * What a screen shows when the data it needs did not arrive.
 *
 * The rule it exists to enforce: an empty state means the server said "none",
 * never that we failed to ask. Every list in the app used to render "No
 * projects yet." with the API stopped, which is a confident lie about the
 * user's own data — and the offer to retry is the other half, because a
 * failure the reader can only respond to by reloading the whole app is barely
 * better than a blank page.
 *
 * cubeui's `QueryError`, worded through `describeError` so the reader sees
 * "Your session has expired" rather than the transport's "Received status code
 * 401". It is an alert, because it stands where the content the reader was
 * waiting for should have been. `compact` is the form for a popover or the
 * sidebar.
 *
 * This is the form for a screen about one thing — a project, the redirect to
 * the first one. A list takes `LoadState`, which adds the loading and empty
 * rungs.
 */
export function LoadFailure(props: Omit<ComponentProps<typeof QueryError>, 'describe'>) {
  return <QueryError describe={describeError} {...props} />;
}

/** What `LoadState` reads off an Apollo `useQuery` result. */
type ApolloResult = {
  loading: boolean;
  error?: unknown;
  data?: unknown;
  refetch: () => unknown;
};

/**
 * cubeui's `QueryState` over an Apollo result: failed, loading, or empty,
 * worded like `LoadFailure`, and nothing once there are rows.
 *
 * Pending and failed both mean *nothing to show*, not merely that a request is
 * out or went wrong. Apollo keeps rendering what it had while it refetches, and
 * a refetch that fails with the last good list still on screen should leave the
 * list there: replacing it with an apology would take away the rows the reader
 * was using, for a failure they did not ask about.
 */
export function LoadState({
  query,
  ...props
}: Omit<ComponentProps<typeof QueryState>, 'describe' | 'query'> & { query: ApolloResult }) {
  const nothing = query.data === undefined;
  return (
    <QueryState
      query={{
        isPending: query.loading && nothing,
        isError: query.error != null && nothing,
        error: query.error,
        refetch: query.refetch,
      }}
      describe={describeError}
      {...props}
    />
  );
}
