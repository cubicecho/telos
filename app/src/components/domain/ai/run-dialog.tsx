import { useQuery } from '@apollo/client';
import { useEffect } from 'react';
import { Text, View } from 'react-native';
import { DialogLayout } from '@/components/dialog-layout';
import { Spinner } from '@/components/ui/spinner';
import { describeError } from '@/lib/errors';
import { RunDocument } from '@/lib/graphql';
import { describeRun, RunLog, RunStatusBadge } from './run-log';
import { RUN_POLL_MS } from './run-row';

/**
 * One run, opened from something it left behind: a note it wrote, a move it
 * made. Followed while it is still going.
 */
export function RunDialog({
  runId,
  open,
  onOpenChange,
  pollMs = RUN_POLL_MS,
}: {
  runId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pollMs?: number;
}) {
  const query = useQuery(RunDocument, {
    variables: { id: runId },
    skip: !open,
    fetchPolicy: 'cache-and-network',
  });
  const run = query.data?.run;
  const running = run?.status === 'running';
  const { startPolling, stopPolling } = query;

  useEffect(() => {
    if (open && running) startPolling(pollMs);
    else stopPolling();
    return () => stopPolling();
  }, [open, running, pollMs, startPolling, stopPolling]);

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={run ? `${run.lane?.name ?? 'A deleted lane'} · ${run.agent?.name ?? 'a deleted agent'}` : 'Run'}
      description={run ? describeRun(run) : undefined}
      content={
        run ? (
          <View className="gap-3">
            <RunStatusBadge status={run.status} />
            <RunLog run={run} />
          </View>
        ) : query.error ? (
          <Text className="text-destructive text-sm">{describeError(query.error)}</Text>
        ) : query.loading ? (
          <Spinner label="Loading the run" />
        ) : (
          <Text className="text-muted-foreground text-sm">That run has been deleted.</Text>
        )
      }
    />
  );
}
