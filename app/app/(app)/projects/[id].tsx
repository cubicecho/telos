import { useQuery } from '@apollo/client';
import { router, useLocalSearchParams } from 'expo-router';
import { Columns3, List } from 'lucide-react';
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { Board } from '@/components/domain/lane/board';
import { ProjectOverview } from '@/components/domain/project/project-overview';
import { TodoComposer } from '@/components/domain/todo/todo-composer';
import { TodoFilterBar } from '@/components/domain/todo/todo-filter-bar';
import { TodoRow } from '@/components/domain/todo/todo-row';
import type { TodoSummary } from '@/components/domain/todo/types';
import { Button } from '@/components/ui/button';
import { LoadFailure } from '@/components/ui/load-failure';
import { type Segment, SegmentedControl, segmentPanelProps } from '@/components/ui/segmented-control';
import { Spinner } from '@/components/ui/spinner';
import { filterTodos, isFiltering, NO_FILTER, type TodoFilter } from '@/lib/filter-todos';
import { ProjectDocument, ProjectLanesDocument, ProjectTodosDocument } from '@/lib/graphql';
import { focusAndSelect, useHotkey } from '@/lib/hotkeys';
import { cn } from '@/lib/utils';

type View = 'list' | 'board';

const VIEWS: readonly Segment<View>[] = [
  { value: 'list', label: 'List', icon: List },
  { value: 'board', label: 'Board', icon: Columns3 },
];

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
  const tabs = useId();
  const composerRef = useRef<HTMLInputElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

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
    if (document.activeElement === filterRef.current) filterRef.current?.blur();
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
  const {
    data: todosData,
    loading: todosLoading,
    error: todosError,
    refetch: refetchTodos,
  } = useQuery(ProjectTodosDocument, {
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

  if (projectLoading && !projectData) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  // Ahead of the not-found message, which is a claim about the caller's own
  // data: with the API unreachable the app has no idea whose the project is,
  // and telling someone their project is gone when it is not is worse than
  // telling them nothing.
  if (projectError && !projectData) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <LoadFailure error={projectError} onRetry={refetchProject} />
      </div>
    );
  }

  const project = projectData?.project;
  if (!project) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <p className="text-muted-foreground text-sm">That project doesn't exist, or isn't yours.</p>
      </div>
    );
  }

  const current: View = view === 'board' ? 'board' : 'list';
  const all = (todosData?.todos ?? []) as TodoSummary[];
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
    // The board is as wide as its columns need; the list stays a column of
    // readable width whatever the window does.
    <div className={cn('mx-auto flex flex-col gap-6 px-6 py-8', current === 'board' ? 'max-w-full' : 'max-w-3xl')}>
      <ProjectOverview project={project} />

      <SegmentedControl
        value={current}
        segments={VIEWS}
        label="Project view"
        idPrefix={tabs}
        onChange={(next) => router.setParams({ view: next })}
      />

      <TodoComposer ref={composerRef} projectId={project.id} nextPosition={nextPosition} lanes={lanes} />

      <TodoFilterBar ref={filterRef} filter={filter} onChange={setFilter} todos={all} matched={todos.length} />

      {todosLoading && all.length === 0 ? (
        <Spinner />
      ) : todosError && all.length === 0 ? (
        <LoadFailure error={todosError} onRetry={refetchTodos} />
      ) : current === 'board' ? (
        <div {...segmentPanelProps(tabs, 'board')}>
          {/* A board with no columns is not a board, and the todos being fine
              does not make it one. */}
          {lanesError && lanes.length === 0 ? (
            <LoadFailure error={lanesError} onRetry={refetchLanes} />
          ) : (
            <Board projectId={project.id} lanes={lanes} todos={todos} />
          )}
        </div>
      ) : (
        <div {...segmentPanelProps(tabs, 'list')} className="flex flex-col gap-6">
          <section className="flex flex-col gap-2">
            {open.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {isFiltering(filter)
                  ? 'Nothing open matches.'
                  : all.length === 0
                    ? 'No todos yet.'
                    : 'Nothing open — everything is blocked or done.'}
              </p>
            ) : (
              open.map((todo) => (
                <TodoRow key={todo.id} todo={todo} projectId={project.id} siblings={all} lanes={lanes} />
              ))
            )}
          </section>

          {blocked.length > 0 ? (
            <section className="flex flex-col gap-2">
              <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                Blocked ({blocked.length})
              </h2>
              {blocked.map((todo) => (
                <TodoRow key={todo.id} todo={todo} projectId={project.id} siblings={all} lanes={lanes} />
              ))}
            </section>
          ) : null}

          {completed.length > 0 ? (
            <section className="flex flex-col gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="-ml-3 self-start text-muted-foreground"
                onClick={() => setShowCompleted((shown) => !shown)}
              >
                {showCompleted ? 'Hide' : 'Show'} completed ({completed.length})
              </Button>
              {showCompleted
                ? completed.map((todo) => (
                    <TodoRow key={todo.id} todo={todo} projectId={project.id} siblings={all} lanes={lanes} />
                  ))
                : null}
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
