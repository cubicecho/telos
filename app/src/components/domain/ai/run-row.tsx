import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { RunSummaryFieldsFragment } from '@/__generated__/graphql';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ChevronDown, ChevronRight } from '@/components/ui/icons';
import { Spinner } from '@/components/ui/spinner';
import { describeError } from '@/lib/errors';
import { CancelRunDocument, DeleteRunDocument, RunDocument } from '@/lib/graphql';
import { describeRun, RunLog, RunStatusBadge } from './run-log';

/** How often an open, live run is asked about again. */
export const RUN_POLL_MS = 2000;

/**
 * One run in a list: a line that says where, who and how it went, and opens
 * onto the whole log. Only an open row loads the log, so a list of a hundred
 * runs polls a hundred summaries rather than a hundred logs.
 */
export function RunRow({
  run,
  showTodo = false,
  pollMs = RUN_POLL_MS,
}: {
  run: RunSummaryFieldsFragment;
  /** Name the todo too, for a list that is not already one todo's. */
  showTodo?: boolean;
  pollMs?: number;
}) {
  const [open, setOpen] = useState(false);
  const [cancelRun, { loading: cancelling }] = useMutation(CancelRunDocument);
  const [deleteRun, { loading: deleting }] = useMutation(DeleteRunDocument);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = run.status === 'running';
  const where = `${run.lane?.name ?? 'A deleted lane'} · ${run.agent?.name ?? 'a deleted agent'}`;
  const title = showTodo ? `${run.todo?.title ?? 'A deleted todo'} — ${where}` : where;

  async function attempt(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  const cancel = () => attempt(() => cancelRun({ variables: { id: run.id } }));
  const remove = () =>
    attempt(() =>
      deleteRun({
        variables: { id: run.id },
        update(cache) {
          cache.evict({ id: cache.identify({ __typename: 'Run', id: run.id }) });
          cache.gc();
        },
      }),
    );

  return (
    <View role="listitem" className="gap-2 rounded-lg border border-border px-3 py-2">
      <View className="flex-row items-center gap-2">
        <Pressable
          role="button"
          aria-expanded={open}
          aria-label={`${title}, ${running ? 'Running' : run.status}`}
          onPress={() => setOpen(!open)}
          className="min-w-0 flex-1 flex-row items-center gap-2"
        >
          {open ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <View className="min-w-0 flex-1 gap-0.5">
            <Text numberOfLines={1} className="text-foreground text-sm">
              {title}
            </Text>
            <Text className="text-muted-foreground text-xs">{describeRun(run)}</Text>
          </View>
        </Pressable>
        {run.verdict === 'none' ? null : (
          <Badge variant={run.verdict === 'pass' ? 'success' : 'destructive'}>
            {run.verdict === 'pass' ? 'Pass' : 'Fail'}
          </Badge>
        )}
        <RunStatusBadge status={run.status} />
        {/* Cancelling asks; the runner stops at its next heartbeat and the run
            is marked stopped then. Until it does, the request is what shows. */}
        {running && !run.cancelRequestedAt ? (
          <Button variant="outline" size="sm" disabled={cancelling} onPress={cancel}>
            Cancel
          </Button>
        ) : null}
        {running && run.cancelRequestedAt ? <Text className="text-muted-foreground text-xs">Stopping…</Text> : null}
        {running ? null : (
          <Button
            variant="ghost"
            size="sm"
            disabled={deleting}
            aria-label={`Delete the run ${title}`}
            onPress={() => setConfirmingDelete(true)}
          >
            Delete
          </Button>
        )}
      </View>

      {error ? (
        <Text className="text-destructive text-sm" aria-live="polite">
          {error}
        </Text>
      ) : null}

      {open ? <OpenRun id={run.id} running={running} pollMs={pollMs} /> : null}

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title="Delete this run?"
        description="Its log and prompts go. What it did to the todo, its notes and its artifacts stay."
        confirmLabel="Delete"
        onConfirm={remove}
      />
    </View>
  );
}

/** A run's full record, asked for while it is open and again while it is live. */
function OpenRun({ id, running, pollMs }: { id: string; running: boolean; pollMs: number }) {
  const query = useQuery(RunDocument, {
    variables: { id },
    fetchPolicy: 'cache-and-network',
    pollInterval: running ? pollMs : 0,
  });
  const run = query.data?.run;
  if (!run) {
    return query.error ? (
      <Text className="text-destructive text-sm">{describeError(query.error)}</Text>
    ) : (
      <Spinner label="Loading the run" />
    );
  }
  return <RunLog run={run} />;
}
