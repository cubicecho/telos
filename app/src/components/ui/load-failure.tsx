import type { ComponentProps } from 'react';
import { QueryError } from '@/components/query-state';
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
 */
export function LoadFailure(props: Omit<ComponentProps<typeof QueryError>, 'describe'>) {
  return <QueryError describe={describeError} {...props} />;
}
