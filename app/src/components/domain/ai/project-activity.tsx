import { useQuery } from '@apollo/client';
import { useMemo } from 'react';
import { Text, View } from 'react-native';
import type { ProjectActivityQuery } from '@/__generated__/graphql';
import { ProjectActivityDocument } from '@/lib/graphql';
import { LiveDot } from './run-log';

/** How often a project's live runs are asked about. */
export const ACTIVITY_POLL_MS = 5000;

/** How far back "spent" looks. */
export const SPEND_DAYS = 30;

export type LiveRun = ProjectActivityQuery['live'][number];

export interface ProjectActivity {
  /** The run working each todo now, by todo id. */
  live: ReadonlyMap<string, LiveRun>;
  spent: ProjectActivityQuery['spent'] | undefined;
  loading: boolean;
}

/**
 * The start of the spend window. Rounded to the hour so the variables, and so
 * the cached answer, hold still between renders and polls.
 */
function spendSince(): string {
  const hour = 60 * 60 * 1000;
  return new Date(Math.floor((Date.now() - SPEND_DAYS * 24 * hour) / hour) * hour).toISOString();
}

/**
 * What a project's agents are doing now and have spent lately, polled while
 * the project is on screen. One query serves the header's line and the
 * board's live marks, so the page polls once.
 */
export function useProjectActivity(projectId: string, { skip = false }: { skip?: boolean } = {}): ProjectActivity {
  const since = useMemo(spendSince, []);
  const query = useQuery(ProjectActivityDocument, {
    variables: { projectId, since },
    skip,
    pollInterval: skip ? 0 : ACTIVITY_POLL_MS,
    fetchPolicy: 'cache-and-network',
  });
  const rows = query.data?.live;
  const live = useMemo(() => new Map((rows ?? []).map((run) => [run.todoId, run])), [rows]);
  return { live, spent: query.data?.spent, loading: query.loading };
}

/** "3 running · 41,200 tokens in 30 days", or nothing before the answer lands. */
export function ProjectActivityLine({ activity }: { activity: ProjectActivity }) {
  if (!activity.spent) return null;
  const running = activity.live.size;
  const tokens = activity.spent.sum?.totalTokens ?? 0;
  const runs = activity.spent.count;
  return (
    <View className="flex-row items-center gap-2">
      {running > 0 ? <LiveDot /> : null}
      <Text className="text-muted-foreground text-sm">
        {[
          running > 0 ? `${running} running` : 'Nothing running',
          `${runs.toLocaleString()} ${runs === 1 ? 'run' : 'runs'} and ${tokens.toLocaleString()} tokens in ${SPEND_DAYS} days`,
        ].join(' · ')}
      </Text>
    </View>
  );
}
