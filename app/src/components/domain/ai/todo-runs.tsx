import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { ArtifactFieldsFragment, RunFieldsFragment } from '@/__generated__/graphql';
import { Badge } from '@/components/ui/badge';
import type { BadgeVariant } from '@/components/ui/badge-base';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronRight } from '@/components/ui/icons';
import { LoadState } from '@/components/ui/load-failure';
import { formatTimestamp } from '@/lib/dates';
import { describeError } from '@/lib/errors';
import { CancelRunDocument, TodoRunsDocument } from '@/lib/graphql';

// A todo's runs — each time a station's agent worked it — and the artifacts
// they left. Drawn only while AI is on for the account and the project; the
// todo dialog decides that, from the same query this reads.

/** How often a todo with a live run is asked about again. */
export const RUN_POLL_MS = 2000;

/** One entry in a run's log, as the runner writes it. */
interface RunEvent {
  at?: string;
  kind?: string;
  name?: string;
  ok?: boolean;
  text?: string;
}

const STATUS: Record<string, { label: string; variant: BadgeVariant }> = {
  running: { label: 'Running', variant: 'warning' },
  ok: { label: 'Finished', variant: 'success' },
  error: { label: 'Failed', variant: 'destructive' },
  stopped: { label: 'Stopped', variant: 'outline' },
};

const EVENT_KINDS: Record<string, string> = {
  tool_call: 'Called',
  tool_result: 'Result',
  hook: 'Hook',
  notice: 'Notice',
};

export function useTodoRuns(todoId: string, { skip = false }: { skip?: boolean } = {}) {
  return useQuery(TodoRunsDocument, { variables: { id: todoId }, skip, fetchPolicy: 'cache-and-network' });
}

export function TodoRuns({ todoId, pollMs = RUN_POLL_MS }: { todoId: string; pollMs?: number }) {
  const query = useTodoRuns(todoId);
  const runs = query.data?.todo?.runs ?? [];
  const artifacts = query.data?.todo?.artifacts ?? [];
  const live = runs.some((run) => run.status === 'running');
  const { startPolling, stopPolling } = query;

  // Asked again only while something is running: a finished run never changes,
  // and a todo nobody is working has nothing new to say.
  useEffect(() => {
    if (live) startPolling(pollMs);
    else stopPolling();
    return () => stopPolling();
  }, [live, pollMs, startPolling, stopPolling]);

  return (
    <View className="gap-6">
      <View className="gap-2">
        <LoadState
          query={query}
          what="the runs"
          count={runs.length}
          empty={<Text className="text-muted-foreground text-sm">No agent has worked this todo yet.</Text>}
        />
        {runs.length === 0 ? null : (
          <View role="list" aria-label="Runs" className="gap-2">
            {runs.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </View>
        )}
      </View>

      {artifacts.length === 0 ? null : (
        <View className="gap-2">
          <Text role="heading" aria-level={3} className="font-medium text-foreground text-sm">
            Artifacts
          </Text>
          <View role="list" aria-label="Artifacts" className="gap-1">
            {artifacts.map((artifact) => (
              <ArtifactRow key={artifact.id} artifact={artifact} />
            ))}
          </View>
        </View>
      )}
    </View>
  );
}

function RunRow({ run }: { run: RunFieldsFragment }) {
  const [open, setOpen] = useState(false);
  const [cancelRun, { loading: cancelling }] = useMutation(CancelRunDocument);
  const [error, setError] = useState<string | null>(null);
  const status = STATUS[run.status] ?? { label: run.status, variant: 'outline' as const };
  const running = run.status === 'running';
  const events = Array.isArray(run.events) ? (run.events as RunEvent[]) : [];
  const title = `${run.lane?.name ?? 'A deleted lane'} · ${run.agent?.name ?? 'a deleted agent'}`;

  async function cancel() {
    setError(null);
    try {
      await cancelRun({ variables: { id: run.id } });
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  return (
    <View role="listitem" className="gap-2 rounded-lg border border-border px-3 py-2">
      <View className="flex-row items-center gap-2">
        <Pressable
          role="button"
          aria-expanded={open}
          aria-label={`${title}, ${status.label}`}
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
        <Badge variant={status.variant}>{status.label}</Badge>
        {/* Cancelling asks; the runner stops at its next heartbeat and the run
            is marked stopped then. Until it does, the request is what shows. */}
        {running && !run.cancelRequestedAt ? (
          <Button variant="outline" size="sm" disabled={cancelling} onPress={cancel}>
            Cancel
          </Button>
        ) : null}
        {running && run.cancelRequestedAt ? <Text className="text-muted-foreground text-xs">Stopping…</Text> : null}
      </View>

      {error ? (
        <Text className="text-destructive text-sm" aria-live="polite">
          {error}
        </Text>
      ) : null}

      {open ? (
        <View className="gap-3">
          {run.error ? (
            <Text selectable className="text-destructive text-sm">
              {run.error}
            </Text>
          ) : null}
          {run.output ? (
            <Text selectable className="whitespace-pre-wrap rounded-md bg-muted px-3 py-2 text-foreground text-sm">
              {run.output}
            </Text>
          ) : null}
          <View role="log" aria-label="Run log" aria-live={running ? 'polite' : 'off'} className="gap-1">
            {events.length === 0 ? (
              <Text className="text-muted-foreground text-xs">
                {running ? 'Nothing logged yet.' : 'Nothing logged.'}
              </Text>
            ) : (
              events.map((event, index) => (
                // The log is append-only, so a position is a stable key.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above
                <Text key={index} selectable className="font-mono text-muted-foreground text-xs">
                  {describeEvent(event)}
                </Text>
              ))
            )}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function describeRun(run: RunFieldsFragment): string {
  const parts = [formatTimestamp(run.startedAt)];
  const seconds = elapsedSeconds(run.startedAt, run.finishedAt);
  if (seconds !== null)
    parts.push(run.finishedAt ? `took ${formatDuration(seconds)}` : `${formatDuration(seconds)} so far`);
  if (run.totalTokens > 0) {
    parts.push(`${run.totalTokens.toLocaleString()} tokens (${run.promptTokens} in, ${run.completionTokens} out)`);
  }
  if (run.toolCalls > 0) parts.push(`${run.toolCalls} tool ${run.toolCalls === 1 ? 'call' : 'calls'}`);
  return parts.join(' · ');
}

function elapsedSeconds(from: string, to: string | null): number | null {
  const start = Date.parse(from);
  const end = to ? Date.parse(to) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, Math.round((end - start) / 1000));
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function describeEvent(event: RunEvent): string {
  const at = event.at ? new Date(event.at) : null;
  const time = at && !Number.isNaN(at.getTime()) ? at.toLocaleTimeString() : '';
  const kind = EVENT_KINDS[event.kind ?? ''] ?? event.kind ?? '';
  const outcome = event.ok === undefined ? '' : event.ok ? ' ✓' : ' ✗';
  const head = [time, kind, event.name].filter(Boolean).join(' ') + outcome;
  return event.text ? `${head}: ${event.text}` : head;
}

function ArtifactRow({ artifact }: { artifact: ArtifactFieldsFragment }) {
  return (
    <View role="listitem" className="flex-row items-center gap-2 rounded-lg border border-border px-3 py-2">
      <View className="min-w-0 flex-1 gap-0.5">
        <Text numberOfLines={1} className="text-foreground text-sm">
          {artifact.title || artifact.location}
        </Text>
        <Text numberOfLines={1} className="text-muted-foreground text-xs">
          {[artifact.title ? artifact.location : null, artifact.mediaType].filter(Boolean).join(' · ')}
        </Text>
      </View>
      <Badge variant="outline">{artifact.action}</Badge>
      <Badge variant="secondary">{artifact.source}</Badge>
    </View>
  );
}
