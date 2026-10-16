import { useMutation, useQuery } from '@apollo/client';
import { Link } from 'expo-router';
import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import {
  type AccountHandedBackQuery,
  HandBack,
  type RunFilters,
  type SpendLineFieldsFragment,
} from '@/__generated__/graphql';
import { Archive } from '@/components/app-icons';
import { ArchivedTodoList } from '@/components/domain/todo/archived-todos';
import { TodoFormDialog } from '@/components/domain/todo/todo-form-dialog';
import type { TodoSummary } from '@/components/domain/todo/types';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { Section } from '@/components/section';
import { StatTile } from '@/components/stat-tile';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CircleCheck, Play, Upload } from '@/components/ui/icons';
import { LoadState } from '@/components/ui/load-failure';
import { SegmentedButton, SegmentedGroup } from '@/components/ui/segmented';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatTimestamp } from '@/lib/dates';
import { describeError } from '@/lib/errors';
import {
  AccountArchivedTodosDocument,
  AccountArtifactsDocument,
  AccountHandedBackDocument,
  AccountRunsDocument,
  AccountSpendDocument,
  RetryTodoDocument,
} from '@/lib/graphql';
import { draftReplies, SPEND_DAYS, spendSince } from './project-activity';
import { RUN_FILTERS, RUNS_PAGE, RUNS_POLL_MS, type RunFilter } from './project-runs';
import { RunDialog } from './run-dialog';
import { RunRow } from './run-row';
import { ArtifactRow, todoLabelOf } from './todo-runs';

// What the account's agents did, across every project it owns: which todos
// wait on a person because of how a run went, what the runs spent, and then the
// runs themselves, what they left behind, and what was archived. Each list is
// the one a project shows, with the project named on every row.

/** How often the handed-back todos, and the spend, are asked about again. */
export const ACCOUNT_POLL_MS = 15_000;

/** The lists under the figures, one at a time. */
export const ACCOUNT_VIEWS = ['runs', 'artifacts', 'archived'] as const;
export type AccountView = (typeof ACCOUNT_VIEWS)[number];

type HandedBackTodo = AccountHandedBackQuery['accountHandedBack'][number];

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
      <HandedBack pollMs={pollMs} />
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
 * "2 of 1 attempts", for a todo its agent gave up on.
 *
 * @param todo - The todo.
 * @returns The line, or null when its agent finished with it instead.
 */
function attemptsLine(todo: HandedBackTodo): string | null {
  if (todo.handedBack !== HandBack.GaveUp) {
    return null;
  }
  return `${todo.attempts} of ${todo.maxAttempts} ${todo.maxAttempts === 1 ? 'attempt' : 'attempts'}`;
}

/** The todos lanes' agents handed back, each with a way to send it round again. */
function HandedBack({ pollMs }: { pollMs: number }) {
  const query = useQuery(AccountHandedBackDocument, { pollInterval: pollMs, fetchPolicy: 'cache-and-network' });
  const todos = query.data?.accountHandedBack ?? [];
  const [watching, setWatching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryTodo, retryState] = useMutation(RetryTodoDocument, { refetchQueries: [AccountHandedBackDocument] });

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
      title="Handed back"
      description="Todos a lane's agent gave up on, or finished with and has nowhere to send."
      contentSlot={
        <View className="gap-2">
          <LoadState
            query={query}
            what="what was handed back"
            count={todos.length}
            emptySlot={<EmptyState iconSlot={<CircleCheck />} title="Nothing is waiting on you." />}
          />
          {error ? (
            <Text className="text-negative text-sm" aria-live="polite">
              {error}
            </Text>
          ) : null}
          <List
            label="Handed back"
            divided={false}
            contentSlot={todos.map((todo) => (
              <View key={todo.todoId} className="gap-1 rounded-lg border border-foreground/10 bg-secondary px-3 py-2.5">
                <View className="flex-row flex-wrap items-center gap-2">
                  {todo.handedBack === HandBack.GaveUp ? (
                    <Badge variant="destructive">Gave up</Badge>
                  ) : (
                    <Badge variant="warning">Finished</Badge>
                  )}
                  <Text className="min-w-0 flex-1 font-medium text-foreground text-sm">{todo.title}</Text>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`Send “${todo.title}” round again`}
                    disabled={retryState.loading}
                    onPress={() => run(() => retryTodo({ variables: { id: todo.todoId } }))}
                    content="Retry"
                  />
                  {todo.runId ? (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Open the last run of “${todo.title}”`}
                      onPress={() => setWatching(todo.runId ?? null)}
                      content="Run"
                    />
                  ) : null}
                  <Link href={`/projects/${todo.projectId}?view=board`} asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Open the board “${todo.title}” is on`}
                      content="Board"
                    />
                  </Link>
                </View>
                <Text className="text-foreground/60 text-xs">
                  {[todo.projectName, todo.laneName, attemptsLine(todo)].filter(Boolean).join(' · ')}
                </Text>
                {todo.reason ? (
                  <Text selectable numberOfLines={3} className="text-sm text-warning">
                    {todo.reason}
                  </Text>
                ) : null}
              </View>
            ))}
          />
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
      contentSlot={
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
            <Text className="text-foreground/60 text-sm">
              {`Runs are kept for ${spend.retentionDays} ${spend.retentionDays === 1 ? 'day' : 'days'}, so these figures start on ${formatTimestamp(spend.keptSince)}, not ${SPEND_DAYS} days back.`}
            </Text>
          ) : null}
          {total && total.draftReplies > 0 ? (
            <Text className="text-foreground/60 text-sm">A draft reply’s tokens are an estimate.</Text>
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
      <List
        label={label}
        contentSlot={lines.map((line) => (
          <View key={line.id ?? line.name} className="flex-row flex-wrap items-baseline gap-x-3 gap-y-0.5 py-0.5">
            {linked && line.id ? (
              <Link href={`/projects/${line.id}?view=runs`} className="min-w-0 flex-1 text-foreground text-sm">
                {line.name}
              </Link>
            ) : (
              <Text className="min-w-0 flex-1 text-foreground text-sm">{line.name}</Text>
            )}
            <Text className="text-foreground/60 text-xs">{runsLine(line)}</Text>
            <Text className="min-w-24 text-right text-foreground text-sm tabular-nums">
              {`${line.totalTokens.toLocaleString()} tokens`}
            </Text>
          </View>
        ))}
      />
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
          emptySlot={
            <Text className="text-foreground/60 text-sm">
              {filter === 'all' ? 'No agent has worked any of your projects yet.' : 'No runs like that.'}
            </Text>
          }
        />
        <List
          label="Runs"
          divided={false}
          contentSlot={runs.map((run) => <RunRow key={run.id} run={run} showTodo project={run.project?.name} />)}
        />
        {/* A full page means there may be more; a short one means there is not. */}
        {runs.length >= limit ? (
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            onPress={() => setLimit(limit + RUNS_PAGE)}
            content="Show more"
          />
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
        emptySlot={<Text className="text-foreground/60 text-sm">No run has left anything behind yet.</Text>}
      />
      <List
        label="Artifacts"
        divided={false}
        contentSlot={artifacts.map((artifact) => {
          // An artifact can outlive its todo: it is then only its project's.
          const { todo } = artifact;
          return (
            <ArtifactRow
              key={artifact.id}
              artifact={artifact}
              todoTitle={[artifact.project?.name, todoLabelOf(artifact)].filter(Boolean).join(' · ')}
              onOpenNote={todo ? (noteId) => setOpened({ todo, noteId }) : undefined}
            />
          );
        })}
      />
      {artifacts.length >= limit ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onPress={() => setLimit(limit + RUNS_PAGE)}
          content="Show more"
        />
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
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            onPress={() => setLimit(limit + RUNS_PAGE)}
            content="Show more"
          />
        ) : null
      }
    />
  );
}
