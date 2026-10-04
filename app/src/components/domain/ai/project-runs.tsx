import { useQuery } from '@apollo/client';
import { useState } from 'react';
import { Text, View } from 'react-native';
import type { RunFilters } from '@/__generated__/graphql';
import { TodoFormDialog } from '@/components/domain/todo/todo-form-dialog';
import type { TodoSummary } from '@/components/domain/todo/types';
import { StatTile } from '@/components/stat-tile';
import { Button } from '@/components/ui/button';
import { LoadState } from '@/components/ui/load-failure';
import { SegmentedButton, SegmentedGroup } from '@/components/ui/segmented';
import { ProjectArtifactsDocument, ProjectRunsDocument } from '@/lib/graphql';
import { draftReplies, type ProjectActivity, SPEND_DAYS } from './project-activity';
import { RunRow } from './run-row';
import { ArtifactRow, todoLabelOf } from './todo-runs';

// A project's runs, every lane and todo together, newest first: the place
// to see what its agents have been doing, and what it cost. An agent's replies
// in the project's drafts are runs too: listed with the rest, marked as drafts,
// and counted in the figures, which say how much of each was theirs.

/** How many runs a page adds. */
export const RUNS_PAGE = 50;

/** How often the list is asked about again while it is on screen. */
export const RUNS_POLL_MS = 5000;

/** The statuses a list of runs can be narrowed to. */
export const RUN_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'error', label: 'Failed' },
  { value: 'stopped', label: 'Stopped' },
  { value: 'ok', label: 'Finished' },
] as const;

export type RunFilter = (typeof RUN_FILTERS)[number]['value'];

export function ProjectRuns({
  projectId,
  activity,
  pollMs = RUNS_POLL_MS,
}: {
  projectId: string;
  activity: ProjectActivity;
  pollMs?: number;
}) {
  const [filter, setFilter] = useState<RunFilter>('all');
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
  const drafting = activity.drafting.length;
  const drafts = activity.draftSpent?.count ?? 0;
  const draftTokens = activity.draftSpent?.sum?.totalTokens ?? 0;

  return (
    <View className="gap-6">
      <View className="flex-row flex-wrap gap-3">
        <StatTile
          className="min-w-40 flex-1"
          label="Running now"
          value={activity.live.size + drafting}
          hint={drafting > 0 ? draftReplies(drafting) : undefined}
          loading={!spent}
          onPress={() => setFilter(filter === 'running' ? 'all' : 'running')}
          selected={filter === 'running'}
        />
        <StatTile
          className="min-w-40 flex-1"
          label="Runs"
          value={(spent?.count ?? 0).toLocaleString()}
          hint={drafts > 0 ? `in ${SPEND_DAYS} days, ${draftReplies(drafts)}` : `in ${SPEND_DAYS} days`}
          loading={!spent}
        />
        <StatTile
          className="min-w-40 flex-1"
          label="Tokens"
          value={(sum?.totalTokens ?? 0).toLocaleString()}
          hint={[
            `${(sum?.promptTokens ?? 0).toLocaleString()} in`,
            `${(sum?.completionTokens ?? 0).toLocaleString()} out`,
            ...(draftTokens > 0 ? [`${draftTokens.toLocaleString()} on drafts`] : []),
            `${SPEND_DAYS} days`,
          ].join(', ')}
          loading={!spent}
        />
      </View>

      <SegmentedGroup
        aria-label="Show runs"
        value={filter}
        onValueChange={(next) => {
          setFilter(next as RunFilter);
          setLimit(RUNS_PAGE);
        }}
        className="self-start"
      >
        {RUN_FILTERS.map((option) => (
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

/**
 * What was made for a project's todos, with the todo each is on. One whose todo
 * has been deleted stays, under the title the todo had.
 */
export function ProjectArtifacts({ projectId }: { projectId: string }) {
  const [limit, setLimit] = useState(RUNS_PAGE);
  const query = useQuery(ProjectArtifactsDocument, {
    variables: { projectId, limit, offset: 0 },
    fetchPolicy: 'cache-and-network',
  });
  const artifacts = query.data?.artifacts ?? [];
  // The todo a note artifact was opened from, and the note: its dialog opens on
  // the thread with that note marked.
  const [opened, setOpened] = useState<{ todo: TodoSummary; noteId: string } | null>(null);

  return (
    <View className="gap-2">
      <LoadState
        query={query}
        what="the artifacts"
        count={artifacts.length}
        empty={
          <Text className="text-muted-foreground text-sm">Nothing has been made for this project’s todos yet.</Text>
        }
      />
      {artifacts.length === 0 ? null : (
        <View role="list" aria-label="Artifacts" className="gap-1">
          {artifacts.map((artifact) => (
            <ArtifactRow
              key={artifact.id}
              artifact={artifact}
              todoTitle={todoLabelOf(artifact)}
              onOpenNote={(noteId) => {
                if (artifact.todo) setOpened({ todo: artifact.todo, noteId });
              }}
            />
          ))}
        </View>
      )}
      {artifacts.length >= limit ? (
        <Button variant="outline" size="sm" className="self-start" onPress={() => setLimit(limit + RUNS_PAGE)}>
          Show more
        </Button>
      ) : null}
      {opened ? (
        <TodoFormDialog
          open
          onOpenChange={(open) => {
            if (!open) setOpened(null);
          }}
          todo={opened.todo}
          initialTab="notes"
          focusNoteId={opened.noteId}
        />
      ) : null}
    </View>
  );
}
