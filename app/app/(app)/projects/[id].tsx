import { useQuery } from '@apollo/client';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Columns3, List } from '@/components/app-icons';
import { Board } from '@/components/domain/lane/board';
import { ProjectPage } from '@/components/domain/project/project-page';
import { TodoComposer } from '@/components/domain/todo/todo-composer';
import { TodoFilterBar } from '@/components/domain/todo/todo-filter-bar';
import { TodoRow } from '@/components/domain/todo/todo-row';
import type { TodoSummary } from '@/components/domain/todo/types';
import { PROSE_COLUMN } from '@/components/header-content-footer';
import { EmptyState } from '@/components/page';
import { PageLayout } from '@/components/page-layout';
import { SectionHeading } from '@/components/section-heading';
import { Button } from '@/components/ui/button';
import { CircleAlert } from '@/components/ui/icons';
import type { InputHandle } from '@/components/ui/input';
import { LoadFailure, LoadState } from '@/components/ui/load-failure';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { filterTodos, isFiltering, NO_FILTER, type TodoFilter } from '@/lib/filter-todos';
import { ProjectDocument, ProjectLanesDocument, ProjectTodosDocument } from '@/lib/graphql';
import { useHotkey } from '@/lib/hotkeys';
import { cn } from '@/lib/utils';

type ProjectView = 'list' | 'board';

/** Focus a field and select what is in it — so typing replaces. */
function focusAndSelect(field: InputHandle | null): void {
  field?.focus();
  field?.select?.();
}

export default function ProjectScreen() {
  // The view and the filter both live in the URL rather than in state, for the
  // same reason: they survive a reload, they are linkable — a filtered board is
  // a thing worth sending someone — and Back undoes them the way it undoes
  // everything else.
  const { id, view, q, label, sort } = useLocalSearchParams<{
    id: string;
    view?: string;
    q?: string;
    label?: string;
    sort?: string;
  }>();
  const [showCompleted, setShowCompleted] = useState(false);
  const composerRef = useRef<InputHandle>(null);
  const filterRef = useRef<InputHandle>(null);

  const filter: TodoFilter = useMemo(
    () => ({ text: q ?? '', labelId: label ?? null, sort: sort === 'due' ? 'due' : 'manual' }),
    [q, label, sort],
  );

  // `undefined` clears a param rather than leaving `?q=` on the URL, so a
  // cleared filter leaves no trace to read back.
  const setFilter = useCallback((next: TodoFilter) => {
    router.setParams({
      q: next.text === '' ? undefined : next.text,
      label: next.labelId ?? undefined,
      sort: next.sort === 'due' ? 'due' : undefined,
    });
  }, []);

  useHotkey('n', (event) => {
    event.preventDefault();
    focusAndSelect(composerRef.current);
  });
  useHotkey('/', (event) => {
    event.preventDefault();
    focusAndSelect(filterRef.current);
  });
  useHotkey('Escape', () => {
    // Two steps, because they are two different wants: the first Escape gives
    // the filter up, the second gives the field up. Clearing and blurring at
    // once would make the common case — a typo in the query — cost a click to
    // get back to.
    if (isFiltering(filter)) {
      setFilter(NO_FILTER);
      return;
    }
    // The field is behind an `InputHandle` now, which offers no identity to
    // compare against and no `blur`, so this gives up whichever text field has
    // focus. Escape inside the composer meaning "leave the field" is the same
    // want, so the wider reach costs nothing.
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) active.blur();
  });

  // Three queries, three failures, and they are not the same failure: the
  // project not loading means there is no screen, while the todos or the lanes
  // not loading means the header is still right and only one panel is empty.
  // Each is reported where its own data would have gone.
  const {
    data: projectData,
    loading: projectLoading,
    error: projectError,
    refetch: refetchProject,
  } = useQuery(ProjectDocument, {
    variables: { id: id as string },
    skip: !id,
  });
  const todosQuery = useQuery(ProjectTodosDocument, {
    variables: { projectId: id as string },
    skip: !id,
  });
  const {
    data: lanesData,
    error: lanesError,
    refetch: refetchLanes,
  } = useQuery(ProjectLanesDocument, {
    variables: { projectId: id as string },
    skip: !id,
  });

  // The title waits at its own height; nothing below it has anything to show
  // until the project lands.
  if (projectLoading && !projectData) {
    return <PageLayout width="full" headerClassName={PROSE_COLUMN} loading title={undefined} content={null} />;
  }

  // Ahead of the not-found message, which is a claim about the caller's own
  // data: with the API unreachable the app has no idea whose the project is,
  // and telling someone their project is gone when it is not is worse than
  // telling them nothing.
  if (projectError && !projectData) {
    return (
      <View className="flex-1 items-center justify-center px-6">
        <LoadFailure error={projectError} onRetry={refetchProject} what="this project" />
      </View>
    );
  }

  const project = projectData?.project;
  if (!project) {
    return (
      <View className="flex-1 justify-center px-6">
        <EmptyState
          icon={CircleAlert}
          title="Project not found"
          description="That project doesn't exist, or isn't yours."
          action={
            <Button variant="outline" size="sm" onPress={() => router.replace('/')}>
              Go to your projects
            </Button>
          }
        />
      </View>
    );
  }

  const current: ProjectView = view === 'board' ? 'board' : 'list';
  const all = (todosQuery.data?.todos ?? []) as TodoSummary[];
  const lanes = lanesData?.lanes ?? [];
  // Filtered once, here, and handed to whichever view is showing — so the two
  // tabs cannot come to disagree about what the filter means.
  const todos = filterTodos(all, filter);
  // Three groups, because they need three different affordances: open todos are
  // actionable now, blocked ones are not (and say why), and completed ones are
  // out of the way until asked for.
  const open = todos.filter((todo) => todo.completedAt == null && !todo.isBlocked);
  const blocked = todos.filter((todo) => todo.completedAt == null && todo.isBlocked);
  const completed = todos.filter((todo) => todo.completedAt != null);
  // Over every todo, not the filtered ones: a new todo goes at the end of the
  // project, and a filter is a way of looking at it rather than a part of it.
  const nextPosition = all.reduce((max, todo) => Math.max(max, todo.position ?? 0), -1) + 1;

  return (
    // The page is full width so the board can be as wide as its columns need,
    // but everything read as text — the header, the composer, the filter and
    // the list — keeps to the reading column. Switching views then moves none
    // of it; only the panel under the switcher changes. A `full` body brings no
    // inset of its own, so each part adds `px-4` to line up with the header.
    <ProjectPage
      project={project}
      content={
        <View className="gap-6 pt-2 pb-6">
          <Tabs
            value={current}
            onValueChange={(next) => router.setParams({ view: next })}
            className="flex flex-col gap-6"
          >
            {/* The composer and the filter serve both views, so they sit above
            the switcher, which sits directly above what it switches. */}
            <View className={cn(PROSE_COLUMN, 'gap-6 px-4')}>
              <TodoComposer ref={composerRef} projectId={project.id} nextPosition={nextPosition} lanes={lanes} />

              <TodoFilterBar ref={filterRef} filter={filter} onChange={setFilter} todos={all} matched={todos.length} />

              <TabsList aria-label="Project view" className="self-start">
                <TabsTrigger value="list">
                  <List />
                  List
                </TabsTrigger>
                <TabsTrigger value="board">
                  <Columns3 />
                  Board
                </TabsTrigger>
              </TabsList>
            </View>

            {/* No `empty`: an empty project still has a board to show, and the
            list's own empty line depends on the filter. The rungs only stand in
            while there is no answer at all. */}
            {todosQuery.data === undefined ? (
              <View className={cn(PROSE_COLUMN, 'px-4')}>
                <LoadState query={todosQuery} what="the todos" count={all.length} />
              </View>
            ) : (
              <>
                <TabsContent value="board" className="mt-0">
                  {/* A board with no columns is not a board, and the todos being fine
                  does not make it one. */}
                  <View className="px-4">
                    {lanesError && lanes.length === 0 ? (
                      <LoadFailure error={lanesError} onRetry={refetchLanes} what="the board" />
                    ) : (
                      <Board projectId={project.id} aiEnabled={project.aiEnabled} lanes={lanes} todos={todos} />
                    )}
                  </View>
                </TabsContent>
                <TabsContent value="list" className="mt-0">
                  {/* The column is a view of its own: on web a display class on the
                  panel itself would beat the `hidden` radix gives it when inactive. */}
                  <View className={cn(PROSE_COLUMN, 'gap-6 px-4')}>
                    <View className="gap-2">
                      {open.length === 0 ? (
                        <Text className="text-muted-foreground text-sm">
                          {isFiltering(filter)
                            ? 'Nothing open matches.'
                            : all.length === 0
                              ? 'No todos yet.'
                              : 'Nothing open — everything is blocked or done.'}
                        </Text>
                      ) : (
                        open.map((todo) => (
                          <TodoRow key={todo.id} todo={todo} projectId={project.id} siblings={all} lanes={lanes} />
                        ))
                      )}
                    </View>

                    {blocked.length > 0 ? (
                      <View role="region" aria-label="Blocked" className="gap-2">
                        <SectionHeading variant="overline" level={2}>
                          {`Blocked (${blocked.length})`}
                        </SectionHeading>
                        {blocked.map((todo) => (
                          <TodoRow key={todo.id} todo={todo} projectId={project.id} siblings={all} lanes={lanes} />
                        ))}
                      </View>
                    ) : null}

                    {completed.length > 0 ? (
                      <View className="gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="-ml-3 self-start text-muted-foreground"
                          aria-expanded={showCompleted}
                          onPress={() => setShowCompleted((shown) => !shown)}
                        >
                          {`${showCompleted ? 'Hide' : 'Show'} completed (${completed.length})`}
                        </Button>
                        {showCompleted
                          ? completed.map((todo) => (
                              <TodoRow key={todo.id} todo={todo} projectId={project.id} siblings={all} lanes={lanes} />
                            ))
                          : null}
                      </View>
                    ) : null}
                  </View>
                </TabsContent>
              </>
            )}
          </Tabs>
        </View>
      }
    />
  );
}
