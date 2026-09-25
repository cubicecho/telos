import { useQuery } from '@apollo/client';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { DialogLayout } from '@/components/dialog-layout';
import { Spinner } from '@/components/ui/spinner';
import { describeError } from '@/lib/errors';
import { RunDocument } from '@/lib/graphql';
import type { LiveRun } from './project-activity';
import { describeRun, RUN_STATUS, RunLog, RunStatusBadge } from './run-log';
import { RUN_POLL_MS } from './run-row';

/**
 * Watch an agent work a todo, from the board. It follows the todo rather than
 * one run: when a run ends and the next station picks the todo up, the dialog
 * moves on to the new run and says so.
 */
export function WatchRunDialog({
  todoTitle,
  live,
  open,
  onOpenChange,
  pollMs = RUN_POLL_MS,
}: {
  todoTitle: string;
  /** The run working the todo now, from the board's activity poll. */
  live: LiveRun | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pollMs?: number;
}) {
  // The run on show. It stays after the run ends, so the reader sees how it
  // finished rather than an empty dialog.
  const [runId, setRunId] = useState(live?.id ?? null);
  const [moved, setMoved] = useState<string | null>(null);

  useEffect(() => {
    if (!live || live.id === runId) return;
    if (runId) setMoved(`A new run started${live.agent ? ` with ${live.agent.name}` : ''}.`);
    setRunId(live.id);
  }, [live, runId]);

  const query = useQuery(RunDocument, {
    variables: { id: runId ?? '' },
    skip: !open || !runId,
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
      title={todoTitle}
      description={
        run
          ? `${run.lane?.name ?? 'A deleted lane'} · ${run.agent?.name ?? 'a deleted agent'} · ${describeRun(run)}`
          : 'Waiting for the run…'
      }
      content={
        <View className="gap-3">
          {moved ? (
            <Text aria-live="polite" className="text-muted-foreground text-sm">
              {moved}
            </Text>
          ) : null}
          {run ? (
            <>
              <View className="flex-row items-center gap-2">
                <RunStatusBadge status={run.status} />
                {running ? null : (
                  <Text className="text-muted-foreground text-sm">
                    {`${RUN_STATUS[run.status]?.label ?? run.status}. Nothing has picked the todo up since.`}
                  </Text>
                )}
              </View>
              <RunLog run={run} />
            </>
          ) : query.error ? (
            <Text className="text-destructive text-sm">{describeError(query.error)}</Text>
          ) : runId ? (
            <Spinner label="Loading the run" />
          ) : (
            <Text className="text-muted-foreground text-sm">No agent is working this todo.</Text>
          )}
        </View>
      }
    />
  );
}
