import { useQuery } from '@apollo/client';
import { useState } from 'react';
import { Text, View } from 'react-native';
import type { RunFilters } from '@/__generated__/graphql';
import { StatTile } from '@/components/stat-tile';
import { Button } from '@/components/ui/button';
import { LoadState } from '@/components/ui/load-failure';
import { SegmentedButton, SegmentedGroup } from '@/components/ui/segmented';
import { ProjectArtifactsDocument, ProjectRunsDocument } from '@/lib/graphql';
import { type ProjectActivity, SPEND_DAYS } from './project-activity';
import { RunRow } from './run-row';
import { ArtifactRow } from './todo-runs';

// A project's runs, every station and todo together, newest first: the place
// to see what its agents have been doing, and what it cost.

/** How many runs a page adds. */
export const RUNS_PAGE = 50;

/** How often the list is asked about again while it is on screen. */
export const RUNS_POLL_MS = 5000;

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'error', label: 'Failed' },
  { value: 'stopped', label: 'Stopped' },
  { value: 'ok', label: 'Finished' },
] as const;

type Filter = (typeof FILTERS)[number]['value'];

export function ProjectRuns({
  projectId,
  activity,
  pollMs = RUNS_POLL_MS,
}: {
  projectId: string;
  activity: ProjectActivity;
  pollMs?: number;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [limit, setLimit] = useState(RUNS_PAGE);
  const where: RunFilters = { projectId: { eq: projectId } };
  if (filter !== 'all') where.status = { eq: filter };

  const query = useQuery(ProjectRunsDocument, {
    variables: { where, limit, offset: 0 },
    pollInterval: pollMs,
    fetchPolicy: 'cache-and-network',
  });
  const runs = query.data?.runs ?? [];
  const spent = activity.spent;
  const sum = spent?.sum;

  return (
    <View className="gap-6">
      <View className="flex-row flex-wrap gap-3">
        <StatTile
          className="min-w-40 flex-1"
          label="Running now"
          value={activity.live.size}
          loading={!spent}
          onPress={() => setFilter(filter === 'running' ? 'all' : 'running')}
          selected={filter === 'running'}
        />
        <StatTile
          className="min-w-40 flex-1"
          label="Runs"
          value={(spent?.count ?? 0).toLocaleString()}
          hint={`in ${SPEND_DAYS} days`}
          loading={!spent}
        />
        <StatTile
          className="min-w-40 flex-1"
          label="Tokens"
          value={(sum?.totalTokens ?? 0).toLocaleString()}
          hint={`${(sum?.promptTokens ?? 0).toLocaleString()} in, ${(sum?.completionTokens ?? 0).toLocaleString()} out, ${SPEND_DAYS} days`}
          loading={!spent}
        />
      </View>

      <SegmentedGroup
        aria-label="Show runs"
        value={filter}
        onValueChange={(next) => {
          setFilter(next as Filter);
          setLimit(RUNS_PAGE);
        }}
        className="self-start"
      >
        {FILTERS.map((option) => (
          <SegmentedButton key={option.value} value={option.value}>
            {option.label}
          </SegmentedButton>
        ))}
      </SegmentedGroup>

      <View className="gap-2">
        <LoadState
          query={query}
          what="the runs"
          count={runs.length}
          empty={
            <Text className="text-muted-foreground text-sm">
              {filter === 'all' ? 'No agent has worked this project yet.' : 'No runs like that.'}
            </Text>
          }
        />
        {runs.length === 0 ? null : (
          <View role="list" aria-label="Runs" className="gap-2">
            {runs.map((run) => (
              <RunRow key={run.id} run={run} showTodo />
            ))}
          </View>
        )}
        {/* A full page means there may be more; a short one means there is not. */}
        {runs.length >= limit ? (
          <Button variant="outline" size="sm" className="self-start" onPress={() => setLimit(limit + RUNS_PAGE)}>
            Show more
          </Button>
        ) : null}
      </View>
    </View>
  );
}

/** What a project's runs left behind, with the todo each is on. */
export function ProjectArtifacts({ projectId }: { projectId: string }) {
  const [limit, setLimit] = useState(RUNS_PAGE);
  const query = useQuery(ProjectArtifactsDocument, {
    variables: { projectId, limit, offset: 0 },
    fetchPolicy: 'cache-and-network',
  });
  const artifacts = query.data?.artifacts ?? [];

  return (
    <View className="gap-2">
      <LoadState
        query={query}
        what="the artifacts"
        count={artifacts.length}
        empty={<Text className="text-muted-foreground text-sm">No run has left anything behind yet.</Text>}
      />
      {artifacts.length === 0 ? null : (
        <View role="list" aria-label="Artifacts" className="gap-1">
          {artifacts.map((artifact) => (
            <ArtifactRow key={artifact.id} artifact={artifact} todoTitle={artifact.todo?.title} />
          ))}
        </View>
      )}
      {artifacts.length >= limit ? (
        <Button variant="outline" size="sm" className="self-start" onPress={() => setLimit(limit + RUNS_PAGE)}>
          Show more
        </Button>
      ) : null}
    </View>
  );
}
