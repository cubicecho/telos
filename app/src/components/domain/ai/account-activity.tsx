import { useMutation, useQuery } from '@apollo/client';
import { Link } from 'expo-router';
import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import type { AccountAttentionQuery, RunFilters, SpendLineFieldsFragment } from '@/__generated__/graphql';
import { Archive } from '@/components/app-icons';
import { ArchivedTodoList } from '@/components/domain/todo/archived-todos';
import { TodoFormDialog } from '@/components/domain/todo/todo-form-dialog';
import type { TodoSummary } from '@/components/domain/todo/types';
import { Section } from '@/components/section';
import { StatTile } from '@/components/stat-tile';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Play, Upload } from '@/components/ui/icons';
import { LoadState } from '@/components/ui/load-failure';
import { SegmentedButton, SegmentedGroup } from '@/components/ui/segmented';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatTimestamp } from '@/lib/dates';
import { describeError } from '@/lib/errors';
import {
  AccountArchivedTodosDocument,
  AccountArtifactsDocument,
  AccountAttentionDocument,
  AccountRunsDocument,
  AccountSpendDocument,
  RetryTodoDocument,
} from '@/lib/graphql';
import { draftReplies, SPEND_DAYS, spendSince } from './project-activity';
import { RUN_FILTERS, RUNS_PAGE, RUNS_POLL_MS, type RunFilter } from './project-runs';
import { RunDialog } from './run-dialog';
import { RunRow } from './run-row';
import { ArtifactRow } from './todo-runs';

// What the account's agents did, across every project it owns: which todos
// wait on a person because of how a run went, what the runs spent, and then the
// runs themselves, what they left behind, and what was archived. Each list is
// the one a project shows, with the project named on every row.

/** How often the todos needing a person, and the spend, are asked about again. */
export const ACCOUNT_POLL_MS = 15_000;

/** The lists under the figures, one at a time. */
export const ACCOUNT_VIEWS = ['runs', 'artifacts', 'archived'] as const;
export type AccountView = (typeof ACCOUNT_VIEWS)[number];

type AttentionTodo = AccountAttentionQuery['accountAttention'][number];

export function AccountActivity({
  view,
  onViewChange,
  pollMs = ACCOUNT_POLL_MS,
  runsPollMs = RUNS_POLL_MS,
}: {
  view: AccountView;
  onViewChange: (view: AccountView) => void;
  pollMs?: number;
  runsPollMs?: number;
}) {
  return (
    <View className="gap-8">
      <NeedsAttention pollMs={pollMs} />
      <AccountSpend pollMs={pollMs} />
      <Tabs
        value={view}
        onValueChange={(next) => onViewChange(ACCOUNT_VIEWS.find((name) => name === next) ?? 'runs')}
        className="flex flex-col gap-6"
      >
        <TabsList aria-label="Activity view" className="self-start">
          <TabsTrigger value="runs">
            <Play />
            Runs
          </TabsTrigger>
          <TabsTrigger value="artifacts">
            <Upload />
            Artifacts
          </TabsTrigger>
          <TabsTrigger value="archived">
            <Archive />
            Archived
          </TabsTrigger>
        </TabsList>
        {/* Only the view that is showing asks for its rows. */}
        <TabsContent value="runs" className="mt-0">
          {view === 'runs' ? <AccountRuns pollMs={runsPollMs} /> : null}
        </TabsContent>
        <TabsContent value="artifacts" className="mt-0">
          {view === 'artifacts' ? <AccountArtifacts /> : null}
        </TabsContent>
        <TabsContent value="archived" className="mt-0">
          {view === 'archived' ? <AccountArchive /> : null}
        </TabsContent>
      </Tabs>
    </View>
  );
}

/**
 * "2 of 1 attempts", for a todo at a station, or how many failed where there is none.
 *
 * @param todo - The todo.
 * @returns The line, or null when it has used no attempt.
 */
function attemptsLine(todo: AttentionTodo): string | null {
  if (todo.maxAttempts != null) {
    return `${todo.attempts} of ${todo.maxAttempts} ${todo.maxAttempts === 1 ? 'attempt' : 'attempts'}`;
  }
  if (todo.attempts > 0) {
    return `${todo.attempts} failed ${todo.attempts === 1 ? 'attempt' : 'attempts'}`;
  }
  return null;
}

/** The todos out of attempts or whose last run errored, each with a way to send it round again. */
function NeedsAttention({ pollMs }: { pollMs: number }) {
  const query = useQuery(AccountAttentionDocument, { pollInterval: pollMs, fetchPolicy: 'cache-and-network' });
  const todos = query.data?.accountAttention ?? [];
  const [watching, setWatching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryTodo, retryState] = useMutation(RetryTodoDocument, { refetchQueries: [AccountAttentionDocument] });

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(describeError(caught));
    }
  }

  return (
    <Section
      title="Needs attention"
      description="Todos that are out of attempts, or whose last run never finished its work."
      content={
        <View className="gap-2">
          <LoadState
            query={query}
            what="what needs attention"
            count={todos.length}
            empty={<Text className="text-muted-foreground text-sm">Nothing is waiting on you.</Text>}
          />
          {error ? (
            <Text className="text-destructive text-sm" aria-live="polite">
              {error}
            </Text>
          ) : null}
          {todos.length > 0 ? (
            <View role="list" aria-label="Needs attention" className="gap-2">
              {todos.map((todo) => (
                <View
                  key={todo.todoId}
                  role="listitem"
                  className="gap-1 rounded-lg border border-border bg-card px-3 py-2.5"
                >
                  <View className="flex-row flex-wrap items-center gap-2">
                    {todo.outOfAttempts ? <Badge variant="destructive">Out of attempts</Badge> : null}
                    {todo.errored ? <Badge variant="warning">Errored</Badge> : null}
                    <Text className="min-w-0 flex-1 font-medium text-foreground text-sm">{todo.title}</Text>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Send “${todo.title}” round again`}
                      disabled={retryState.loading}
                      onPress={() => run(() => retryTodo({ variables: { id: todo.todoId } }))}
                    >
                      Retry
                    </Button>
                    {todo.runId ? (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Open the last run of “${todo.title}”`}
                        onPress={() => setWatching(todo.runId ?? null)}
                      >
                        Run
                      </Button>
                    ) : null}
                    <Link href={`/projects/${todo.projectId}?view=board`} asChild>
                      <Button variant="ghost" size="sm" aria-label={`Open the board “${todo.title}” is on`}>
                        Board
                      </Button>
                    </Link>
                  </View>
                  <Text className="text-muted-foreground text-xs">
                    {[todo.projectName, todo.laneName ?? 'no lane', attemptsLine(todo)].filter(Boolean).join(' · ')}
                  </Text>
                  {todo.reason ? (
                    <Text selectable numberOfLines={3} className="text-amber-700 text-sm dark:text-amber-400">
                      {todo.reason}
                    </Text>
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}
          {watching ? <RunDialog runId={watching} open onOpenChange={(next) => !next && setWatching(null)} /> : null}
        </View>
      }
    />
  );
}

/**
 * "12 runs, 2 draft replies", for a spend line.
 *
 * @param line - The line.
 * @returns Its counts.
 */
function runsLine(line: SpendLineFieldsFragment): string {
  const runs = `${line.runs.toLocaleString()} ${line.runs === 1 ? 'run' : 'runs'}`;
  return line.draftReplies > 0 ? `${runs}, ${draftReplies(line.draftReplies)}` : runs;
}

/** What the runs of the window spent, in all, by project and by agent. */
function AccountSpend({ pollMs }: { pollMs: number }) {
  const since = useMemo(spendSince, []);
  const query = useQuery(AccountSpendDocument, {
    variables: { since },
    pollInterval: pollMs,
    fetchPolicy: 'cache-and-network',
  });
  const spend = query.data?.accountSpend;
  const total = spend?.total;

  return (
    <Section
      title="Spend"
      description={`What your agents’ runs used in the last ${SPEND_DAYS} days, across every project.`}
      content={
        <View className="gap-4">
          <View className="flex-row flex-wrap gap-3">
            <StatTile
              className="min-w-40 flex-1"
              label="Runs"
              value={(total?.runs ?? 0).toLocaleString()}
              hint={
                total && total.draftReplies > 0
                  ? `in ${SPEND_DAYS} days, ${draftReplies(total.draftReplies)}`
                  : `in ${SPEND_DAYS} days`
              }
              loading={!spend}
            />
            <StatTile
              className="min-w-40 flex-1"
              label="Tokens"
              value={(total?.totalTokens ?? 0).toLocaleString()}
              hint={`${(total?.promptTokens ?? 0).toLocaleString()} in, ${(total?.completionTokens ?? 0).toLocaleString()} out`}
              loading={!spend}
            />
          </View>
          {query.error && !spend ? <LoadState query={query} what="the spend" count={0} /> : null}
          {/* Retention deletes old runs, so a window longer than it is not whole. */}
          {spend?.keptSince ? (
            <Text className="text-muted-foreground text-sm">
              {`Runs are kept for ${spend.retentionDays} ${spend.retentionDays === 1 ? 'day' : 'days'}, so these figures start on ${formatTimestamp(spend.keptSince)}, not ${SPEND_DAYS} days back.`}
            </Text>
          ) : null}
          {total && total.draftReplies > 0 ? (
            <Text className="text-muted-foreground text-sm">A draft reply’s tokens are an estimate.</Text>
          ) : null}
          {spend && spend.total.runs > 0 ? (
            <View className="flex-row flex-wrap gap-6">
              <SpendList label="By project" lines={spend.byProject} linked />
              <SpendList label="By agent" lines={spend.byAgent} />
            </View>
          ) : null}
        </View>
      }
    />
  );
}

/** Spend lines under a heading: each one's name, its runs and its tokens. */
function SpendList({
  label,
  lines,
  linked = false,
}: {
  label: string;
  lines: readonly SpendLineFieldsFragment[];
  /** Whether a line's id is a project to open. */
  linked?: boolean;
}) {
  return (
    <View className="min-w-64 flex-1 gap-1">
      <Text className="font-medium text-foreground text-sm">{label}</Text>
      <View role="list" aria-label={label}>
        {lines.map((line) => (
          <View
            key={line.id ?? line.name}
            role="listitem"
            className="flex-row flex-wrap items-baseline gap-x-3 gap-y-0.5 border-border border-b py-1.5"
          >
            {linked && line.id ? (
              <Link href={`/projects/${line.id}?view=runs`} className="min-w-0 flex-1 text-foreground text-sm">
                {line.name}
              </Link>
            ) : (
              <Text className="min-w-0 flex-1 text-foreground text-sm">{line.name}</Text>
            )}
            <Text className="text-muted-foreground text-xs">{runsLine(line)}</Text>
            <Text className="min-w-24 text-right text-foreground text-sm tabular-nums">
              {`${line.totalTokens.toLocaleString()} tokens`}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** Every project's runs, newest first, a draft's replies among them. */
function AccountRuns({ pollMs }: { pollMs: number }) {
  const [filter, setFilter] = useState<RunFilter>('all');
  const [limit, setLimit] = useState(RUNS_PAGE);
  const where: RunFilters = filter === 'all' ? {} : { status: { eq: filter } };
  const query = useQuery(AccountRunsDocument, {
    variables: { where, limit, offset: 0 },
    pollInterval: pollMs,
    fetchPolicy: 'cache-and-network',
  });
  const runs = query.data?.runs ?? [];

  return (
    <View className="gap-4">
      <SegmentedGroup
        aria-label="Show runs"
        value={filter}
        onValueChange={(next) => {
          setFilter(RUN_FILTERS.find((option) => option.value === next)?.value ?? 'all');
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
              {filter === 'all' ? 'No agent has worked any of your projects yet.' : 'No runs like that.'}
            </Text>
          }
        />
        {runs.length === 0 ? null : (
          <View role="list" aria-label="Runs" className="gap-2">
            {runs.map((run) => (
              <RunRow key={run.id} run={run} showTodo project={run.project?.name} />
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

/** What every project's runs left behind, newest first. */
function AccountArtifacts() {
  const [limit, setLimit] = useState(RUNS_PAGE);
  const query = useQuery(AccountArtifactsDocument, {
    variables: { limit, offset: 0 },
    fetchPolicy: 'cache-and-network',
  });
  const artifacts = query.data?.artifacts ?? [];
  // The todo a note artifact was opened from, and the note.
  const [opened, setOpened] = useState<{ todo: TodoSummary; noteId: string } | null>(null);

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
          {artifacts.map((artifact) => {
            // An artifact can outlive its todo: it is then only its project's.
            const { todo } = artifact;
            return (
              <ArtifactRow
                key={artifact.id}
                artifact={artifact}
                todoTitle={[artifact.project?.name, todo?.title].filter(Boolean).join(' · ') || undefined}
                onOpenNote={todo ? (noteId) => setOpened({ todo, noteId }) : undefined}
              />
            );
          })}
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

/** Every project's archived todos, the latest put away first. */
function AccountArchive() {
  const [limit, setLimit] = useState(RUNS_PAGE);
  const query = useQuery(AccountArchivedTodosDocument, {
    variables: { limit, offset: 0 },
    fetchPolicy: 'cache-and-network',
  });
  const todos = query.data?.todos ?? [];
  return (
    <ArchivedTodoList
      query={query}
      todos={todos}
      onRestore={[AccountArchivedTodosDocument]}
      onDelete={[AccountArchivedTodosDocument]}
      footer={
        todos.length >= limit ? (
          <Button variant="outline" size="sm" className="self-start" onPress={() => setLimit(limit + RUNS_PAGE)}>
            Show more
          </Button>
        ) : null
      }
    />
  );
}
