import { useQuery } from '@apollo/client';
import { useMemo } from 'react';
import { Text, View } from 'react-native';
import { type ProjectActivityQuery, WorkState } from '@/__generated__/graphql';
import { ProjectActivityDocument } from '@/lib/graphql';
import { LiveDot } from './run-log';

/** How often a project's live runs are asked about. */
export const ACTIVITY_POLL_MS = 5000;

/** How far back "spent" looks. */
export const SPEND_DAYS = 30;

export type LiveRun = ProjectActivityQuery['live'][number];

/** Where a todo stands with the lanes' agents. */
export type WorkTodo = ProjectActivityQuery['work']['todos'][number];

/** A todo an agent gave up on or finished with, and why. */
export type StuckTodo = WorkTodo;

/** A todo an agent would work if asked, or has been asked to and has not started. */
export type WaitingTodo = WorkTodo;

export interface ProjectActivity {
  /** The run working each todo now, by todo id. */
  live: ReadonlyMap<string, LiveRun>;
  /** The todos waiting on a person, by todo id. */
  stuck: ReadonlyMap<string, StuckTodo>;
  /** The todos waiting to be asked for, or asked for and not yet started, by todo id. */
  waiting: ReadonlyMap<string, WaitingTodo>;
  /** The todos whose agent asked a person something and waits for the answer, by todo id. */
  asked: ReadonlyMap<string, WorkTodo>;
  /** Every run in the window. */
  spent: ProjectActivityQuery['spent'] | undefined;
  loading: boolean;
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
  const live = useMemo(() => new Map((rows ?? []).map((run) => [run.todoId, run])), [rows]);
  const work = query.data?.work.todos;
  const stuck = useMemo(
    () =>
      new Map((work ?? []).filter((todo) => todo.state === WorkState.HandedBack).map((todo) => [todo.todoId, todo])),
    [work],
  );
  const waiting = useMemo(
    () =>
      new Map(
        (work ?? [])
          .filter(
            (todo) => todo.awaitsRun || ((todo.runRequested || todo.following) && todo.state === WorkState.Queued),
          )
          .map((todo) => [todo.todoId, todo]),
      ),
    [work],
  );
  const asked = useMemo(
    () => new Map((work ?? []).filter((todo) => todo.state === WorkState.Asked).map((todo) => [todo.todoId, todo])),
    [work],
  );
  return {
    live,
    stuck,
    waiting,
    asked,
    spent: query.data?.spent,
    loading: query.loading,
  };
}

/**
 * "2 waiting on you · 3 running · 12 runs and 41,200 tokens in 30 days", or
 * nothing before the answer lands. What waits on a person comes first, in the
 * card badge's amber, since it is the part that asks something of the reader.
 */
export function ProjectActivityLine({ activity }: { activity: ProjectActivity }) {
  if (!activity.spent) return null;
  const running = activity.live.size;
  const asked = activity.asked.size;
  const tokens = activity.spent.sum?.totalTokens ?? 0;
  const runs = activity.spent.count;
  const spend = `${runs.toLocaleString()} ${runs === 1 ? 'run' : 'runs'} and ${tokens.toLocaleString()} tokens in ${SPEND_DAYS} days`;
  return (
    <View className="flex-row items-center gap-2">
      {running > 0 ? <LiveDot /> : null}
      {asked > 0 ? <Text className="text-sm text-warning">{asked} waiting on you ·</Text> : null}
      <Text className="text-foreground/60 text-sm">
        {[running > 0 ? `${running} running` : 'Nothing running', spend].join(' · ')}
      </Text>
    </View>
  );
}
