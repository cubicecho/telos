import { useMutation, useQuery } from '@apollo/client';
import { Link } from 'expo-router';
import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import type { AiStatusQuery } from '@/__generated__/graphql';
import { Section } from '@/components/section';
import { StatTile } from '@/components/stat-tile';
import { Badge } from '@/components/ui/badge';
import type { BadgeVariant } from '@/components/ui/badge-base';
import { Button } from '@/components/ui/button';
import { LoadState } from '@/components/ui/load-failure';
import { useAi } from '@/lib/ai';
import { describeError } from '@/lib/errors';
import { AiAttentionDocument, AiStatusDocument, RecentFailuresDocument, RetryTodoDocument } from '@/lib/graphql';
import { cn } from '@/lib/utils';
import { RunDialog } from './run-dialog';
import { formatDuration, LiveDot } from './run-log';
import { RunRow } from './run-row';

// Where the stations stand, across every project with AI on: what waits on a
// person, what is running, what is waiting its turn and what no station will
// ever reach; each lane counted; the runs that failed lately; and whether the
// runner is there at all.

/** How often the page asks again. */
export const STATUS_POLL_MS = 5000;

/** How often the sidebar asks how many todos need a person. */
export const ATTENTION_POLL_MS = 30_000;

/** Longer than this since the runner asked for work, and it is probably not running. */
export const RUNNER_QUIET_SECONDS = 60;

/** How far back "failed lately" looks. */
const FAILURE_HOURS = 24;

type State = 'attention' | 'running' | 'blocked' | 'queued' | 'parked' | 'done';
type StationTodo = AiStatusQuery['aiStatus']['todos'][number];

const STATES: Array<{ value: State; label: string; blurb: string; variant: BadgeVariant }> = [
  {
    value: 'attention',
    label: 'Needs you',
    blurb: 'A station gave up on these, or finished and has nowhere to send them.',
    variant: 'destructive',
  },
  { value: 'running', label: 'Running', blurb: 'An agent is working these now.', variant: 'warning' },
  { value: 'blocked', label: 'Blocked', blurb: 'These wait on something unfinished.', variant: 'outline' },
  { value: 'queued', label: 'Queued', blurb: 'A station will start these when it has room.', variant: 'secondary' },
  { value: 'parked', label: 'Parked', blurb: 'No station will reach these where they are.', variant: 'outline' },
  { value: 'done', label: 'Done', blurb: 'Finished.', variant: 'success' },
];

export function AiStatus({ pollMs = STATUS_POLL_MS }: { pollMs?: number }) {
  const [focus, setFocus] = useState<State>('attention');
  const [watching, setWatching] = useState<string | null>(null);
  const query = useQuery(AiStatusDocument, { pollInterval: pollMs, fetchPolicy: 'cache-and-network' });
  const status = query.data?.aiStatus;
  const [retryTodo, retryState] = useMutation(RetryTodoDocument, { refetchQueries: [AiStatusDocument] });

  const counts = useMemo(() => {
    const tally: Record<State, number> = { attention: 0, running: 0, blocked: 0, queued: 0, parked: 0, done: 0 };
    for (const todo of status?.todos ?? []) tally[todo.state as State] += 1;
    for (const project of status?.projects ?? []) for (const lane of project.lanes) tally.done += lane.done;
    return tally;
  }, [status]);
  const projects = useMemo(
    () => new Map((status?.projects ?? []).map((project) => [project.projectId, project])),
    [status],
  );
  const shown = (status?.todos ?? []).filter((todo) => todo.state === focus);
  const focused = STATES.find((state) => state.value === focus) ?? STATES[0];

  function where(todo: StationTodo): string {
    const project = projects.get(todo.projectId);
    const lane = project?.lanes.find((row) => row.laneId === todo.laneId);
    return [project?.name, lane?.name ?? 'no lane'].filter(Boolean).join(' · ');
  }

  return (
    <View className="gap-8">
      <RunnerLine seenAt={status?.runnerSeenAt} loaded={!!status} />

      <View className="flex-row flex-wrap gap-3">
        {STATES.map((state) => (
          <StatTile
            key={state.value}
            className="min-w-32 flex-1"
            label={state.label}
            value={counts[state.value].toLocaleString()}
            loading={!status}
            onPress={state.value === 'done' ? undefined : () => setFocus(state.value)}
            selected={focus === state.value}
            valueClassName={state.value === 'attention' && counts.attention > 0 ? 'text-destructive' : undefined}
            icon={
              (state.value === 'attention' || state.value === 'running') && counts[state.value] > 0 ? (
                <LiveDot />
              ) : undefined
            }
          />
        ))}
      </View>

      <Section
        title={focused.label}
        description={focused.blurb}
        content={
          <View className="gap-2">
            <LoadState
              query={query}
              what="where things stand"
              count={shown.length}
              empty={
                <Text className="text-muted-foreground text-sm">
                  {focus === 'attention'
                    ? `Nothing is waiting on you. ${counts.running} running, ${counts.queued} queued.`
                    : 'None.'}
                </Text>
              }
            />
            {retryState.error ? (
              <Text className="text-destructive text-sm">{describeError(retryState.error)}</Text>
            ) : null}
            {shown.length > 0 ? (
              <View role="list" aria-label={focused.label} className="gap-2">
                {shown.map((todo) => (
                  <View
                    key={todo.todoId}
                    role="listitem"
                    className="gap-1 rounded-lg border border-border bg-card px-3 py-2.5"
                  >
                    <View className="flex-row items-center gap-2">
                      <Badge variant={focused.variant}>{focused.label}</Badge>
                      <Text className="min-w-0 flex-1 font-medium text-foreground text-sm">{todo.title}</Text>
                      {todo.state === 'attention' ? (
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={`Send “${todo.title}” round again`}
                          disabled={retryState.loading}
                          onPress={() => retryTodo({ variables: { id: todo.todoId } }).catch(() => undefined)}
                        >
                          Retry
                        </Button>
                      ) : null}
                      {todo.liveRunId ? (
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={`Watch the agent work “${todo.title}”`}
                          onPress={() => setWatching(todo.liveRunId ?? null)}
                        >
                          Watch
                        </Button>
                      ) : null}
                      <Link href={`/projects/${todo.projectId}?view=board`} asChild>
                        <Button variant="ghost" size="sm" aria-label={`Open the board “${todo.title}” is on`}>
                          Board
                        </Button>
                      </Link>
                    </View>
                    <Text className="text-muted-foreground text-xs">
                      {where(todo)}
                      {todo.failures > 0
                        ? ` · ${todo.failures} failed ${todo.failures === 1 ? 'attempt' : 'attempts'}`
                        : ''}
                    </Text>
                    {todo.reason ? (
                      <Text
                        selectable
                        numberOfLines={3}
                        className={cn(
                          'text-sm',
                          todo.state === 'attention' ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground',
                        )}
                      >
                        {todo.reason}
                      </Text>
                    ) : null}
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        }
      />

      <Section
        title="Lanes"
        description="Every lane in your AI projects, and where its todos stand."
        content={
          status && status.projects.length === 0 ? (
            <Text className="text-muted-foreground text-sm">No project has AI on.</Text>
          ) : (
            <View className="gap-4">
              {(status?.projects ?? []).map((project) => (
                <View key={project.projectId} className="gap-1">
                  <Link
                    href={`/projects/${project.projectId}?view=board`}
                    className="font-medium text-foreground text-sm"
                  >
                    {project.name}
                  </Link>
                  <View role="list" aria-label={`${project.name}’s lanes`}>
                    {project.lanes.map((lane) => (
                      <View
                        key={lane.laneId}
                        role="listitem"
                        className="flex-row flex-wrap items-baseline gap-x-3 gap-y-0.5 border-border border-b py-1.5"
                      >
                        <Text className="min-w-32 text-foreground text-sm">{lane.name}</Text>
                        <Text className="text-muted-foreground text-xs">
                          {lane.station ? 'station' : lane.isDone ? 'done lane' : 'resting place'}
                        </Text>
                        <Text className="flex-1 text-right text-muted-foreground text-xs">
                          {STATES.filter((state) => lane[state.value] > 0).map((state, index) => (
                            <Text
                              key={state.value}
                              className={state.value === 'attention' ? 'text-destructive' : undefined}
                            >
                              {index > 0 ? ' · ' : ''}
                              {lane[state.value]} {state.label.toLowerCase()}
                            </Text>
                          ))}
                          {STATES.every((state) => lane[state.value] === 0) ? 'empty' : null}
                        </Text>
                      </View>
                    ))}
                  </View>
                </View>
              ))}
            </View>
          )
        }
      />

      <RecentFailures pollMs={pollMs} />

      {watching ? <RunDialog runId={watching} open onOpenChange={(next) => !next && setWatching(null)} /> : null}
    </View>
  );
}

/** Whether the runner is there: when it last asked for work. */
function RunnerLine({ seenAt, loaded }: { seenAt: string | null | undefined; loaded: boolean }) {
  if (!loaded) return null;
  const seconds = seenAt ? Math.max(0, Math.round((Date.now() - Date.parse(seenAt)) / 1000)) : null;
  const quiet = seconds === null || seconds > RUNNER_QUIET_SECONDS;
  return (
    <View className="flex-row items-center gap-2">
      {quiet ? <View aria-hidden className="size-2 rounded-full bg-amber-500" /> : <LiveDot />}
      <Text className="text-muted-foreground text-sm">
        {seconds === null
          ? 'The runner has not asked for work since the server started. Nothing will be picked up until it does.'
          : quiet
            ? `The runner last asked for work ${formatDuration(seconds)} ago. It may have stopped.`
            : 'The runner is asking for work.'}
      </Text>
    </View>
  );
}

function RecentFailures({ pollMs }: { pollMs: number }) {
  const since = useMemo(() => {
    const hour = 60 * 60 * 1000;
    return new Date(Math.floor((Date.now() - FAILURE_HOURS * hour) / hour) * hour).toISOString();
  }, []);
  const query = useQuery(RecentFailuresDocument, {
    variables: { since },
    pollInterval: pollMs * 3,
    fetchPolicy: 'cache-and-network',
  });
  const runs = query.data?.runs ?? [];
  return (
    <Section
      title="Failed lately"
      description={`Runs that failed in the last ${FAILURE_HOURS} hours, newest first.`}
      content={
        <View className="gap-2">
          <LoadState
            query={query}
            what="the failed runs"
            count={runs.length}
            empty={<Text className="text-muted-foreground text-sm">No run failed.</Text>}
          />
          {runs.length > 0 ? (
            <View role="list" aria-label="Failed runs" className="gap-2">
              {runs.map((run) => (
                <RunRow key={run.id} run={run} showTodo />
              ))}
            </View>
          ) : null}
        </View>
      }
    />
  );
}

/** How many todos wait on a person, for the sidebar. Nothing while AI is off. */
export function useAttentionCount(): number {
  const ai = useAi();
  const query = useQuery(AiAttentionDocument, {
    skip: !ai.on,
    pollInterval: ai.on ? ATTENTION_POLL_MS : 0,
    fetchPolicy: 'cache-and-network',
  });
  return (query.data?.aiStatus.todos ?? []).filter((todo) => todo.state === 'attention').length;
}
