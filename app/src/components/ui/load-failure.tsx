import { useState } from 'react';
import { Text, View } from 'react-native';
import { RotateCw } from '@/components/app-icons';
import { Button } from '@/components/ui/button';
import { TriangleAlert } from '@/components/ui/icons';
import { describeError } from '@/lib/errors';
import { cn } from '@/lib/utils';

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
 * Not cubeui's `QueryError`, which is the same idea as a full card: this one
 * sits inline — in a popover, in the sidebar — and words the failure through
 * `describeError` rather than showing the raw `message`.
 */
export function LoadFailure({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  /** Apollo's `refetch`. Its rejection is expected — a retry may fail too. */
  onRetry?: () => unknown;
  className?: string;
}) {
  const [retrying, setRetrying] = useState(false);

  async function retry() {
    if (!onRetry) return;
    setRetrying(true);
    try {
      await onRetry();
    } catch {
      // Swallowed on purpose: the query's own `error` is what the screen
      // reads, and it is already being rendered right here. Rethrowing would
      // only turn a visible failure into an unhandled rejection as well.
    } finally {
      setRetrying(false);
    }
  }

  return (
    // `role="alert"` rather than a live region: this replaces the content the
    // reader was waiting for, so it is worth interrupting for.
    <View role="alert" className={cn('items-start gap-2', className)}>
      <View className="flex-row items-start gap-2">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
        <Text className="shrink text-muted-foreground text-sm">{describeError(error)}</Text>
      </View>
      {onRetry ? (
        <Button variant="outline" size="sm" className="gap-1.5" onPress={retry} disabled={retrying}>
          <RotateCw className={cn('h-3.5 w-3.5', retrying && 'animate-spin')} aria-hidden />
          {retrying ? 'Retrying…' : 'Retry'}
        </Button>
      ) : null}
    </View>
  );
}
