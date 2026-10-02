import { useQuery } from '@apollo/client';
import { useMemo } from 'react';
import { Text, View } from 'react-native';
import type { ProjectActivityQuery } from '@/__generated__/graphql';
import { ProjectActivityDocument } from '@/lib/graphql';
import { DRAFT_RUN, LiveDot } from './run-log';

/** How often a project's live runs are asked about. */
export const ACTIVITY_POLL_MS = 5000;

/** How far back "spent" looks. */
export const SPEND_DAYS = 30;

export type LiveRun = ProjectActivityQuery['live'][number];

/** Where a todo stands with the stations. */
export type StationTodo = ProjectActivityQuery['stations']['todos'][number];

/** A todo a station gave up on or finished with, and why. */
export type StuckTodo = StationTodo;

/** A todo a station would work if asked, or has been asked to and has not started. */
export type WaitingTodo = StationTodo;

export interface ProjectActivity {
  /** The run working each todo now, by todo id. */
  live: ReadonlyMap<string, LiveRun>;
  /** The replies being written in drafts now: runs with no todo to mark. */
  drafting: readonly LiveRun[];
  /** The todos waiting on a person, by todo id. */
  stuck: ReadonlyMap<string, StuckTodo>;
  /** The todos waiting to be asked for, or asked for and not yet started, by todo id. */
  waiting: ReadonlyMap<string, WaitingTodo>;
  /** Every run in the window, a draft's replies among them. */
  spent: ProjectActivityQuery['spent'] | undefined;
  /** How much of `spent` was replies in drafts. */
  draftSpent: ProjectActivityQuery['draftSpent'] | undefined;
  loading: boolean;
}

/**
 * "2 draft replies", for a count of them.
 *
 * @param count - How many.
 * @returns The count and its noun.
 */
export function draftReplies(count: number): string {
  return `${count.toLocaleString()} draft ${count === 1 ? 'reply' : 'replies'}`;
}

/**
 * The start of the spend window. Rounded to the hour so the variables, and so
 * the cached answer, hold still between renders and polls.
 */
export function spendSince(): string {
  const hour = 60 * 60 * 1000;
  return new Date(Math.floor((Date.now() - SPEND_DAYS * 24 * hour) / hour) * hour).toISOString();
}

/**
 * What a project's agents are doing now and have spent lately, and which todos
 * wait on a person or on being asked for, polled while the project is on screen. One query serves
 * the header's line and the board's marks, so the page polls once.
 */
export function useProjectActivity(projectId: string, { skip = false }: { skip?: boolean } = {}): ProjectActivity {
  const since = useMemo(spendSince, []);
  const query = useQuery(ProjectActivityDocument, {
    variables: { projectId, project: projectId, since },
    skip,
    pollInterval: skip ? 0 : ACTIVITY_POLL_MS,
    fetchPolicy: 'cache-and-network',
  });
  const rows = query.data?.live;
  // A draft's reply is a run with no todo: it marks no card, and is counted beside them.
  const live = useMemo(() => {
    const byTodo = new Map<string, LiveRun>();
    for (const run of rows ?? []) {
      if (run.todoId) {
        byTodo.set(run.todoId, run);
      }
    }
    return byTodo;
  }, [rows]);
  const drafting = useMemo(() => (rows ?? []).filter((run) => run.kind === DRAFT_RUN), [rows]);
  const stations = query.data?.stations.todos;
  const stuck = useMemo(
    () => new Map((stations ?? []).filter((todo) => todo.state === 'attention').map((todo) => [todo.todoId, todo])),
    [stations],
  );
  const waiting = useMemo(
    () =>
      new Map(
        (stations ?? [])
          .filter((todo) => todo.awaitsRun || (todo.runRequested && todo.state === 'queued'))
          .map((todo) => [todo.todoId, todo]),
      ),
    [stations],
  );
  return {
    live,
    drafting,
    stuck,
    waiting,
    spent: query.data?.spent,
    draftSpent: query.data?.draftSpent,
    loading: query.loading,
  };
}

/**
 * "3 running, 1 draft reply · 12 runs and 41,200 tokens in 30 days, 4 draft
 * replies among them", or nothing before the answer lands.
 */
export function ProjectActivityLine({ activity }: { activity: ProjectActivity }) {
  if (!activity.spent) return null;
  const drafting = activity.drafting.length;
  const running = activity.live.size + drafting;
  const tokens = activity.spent.sum?.totalTokens ?? 0;
  const runs = activity.spent.count;
  const drafts = activity.draftSpent?.count ?? 0;
  const spend = `${runs.toLocaleString()} ${runs === 1 ? 'run' : 'runs'} and ${tokens.toLocaleString()} tokens in ${SPEND_DAYS} days`;
  return (
    <View className="flex-row items-center gap-2">
      {running > 0 ? <LiveDot /> : null}
      <Text className="text-muted-foreground text-sm">
        {[
          running > 0 ? `${running} running${drafting > 0 ? `, ${draftReplies(drafting)}` : ''}` : 'Nothing running',
          drafts > 0 ? `${spend}, ${draftReplies(drafts)} among them` : spend,
        ].join(' · ')}
      </Text>
    </View>
  );
}
