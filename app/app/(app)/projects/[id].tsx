import { useQuery } from '@apollo/client';
import { router, useLocalSearchParams } from 'expo-router';
import { Columns3, List } from 'lucide-react';
import { useId, useState } from 'react';
import { Board } from '@/components/domain/lane/board';
import { ProjectOverview } from '@/components/domain/project/project-overview';
import { TodoComposer } from '@/components/domain/todo/todo-composer';
import { TodoRow } from '@/components/domain/todo/todo-row';
import type { TodoSummary } from '@/components/domain/todo/types';
import { Button } from '@/components/ui/button';
import { type Segment, SegmentedControl, segmentPanelProps } from '@/components/ui/segmented-control';
import { Spinner } from '@/components/ui/spinner';
import { ProjectDocument, ProjectLanesDocument, ProjectTodosDocument } from '@/lib/graphql';
import { cn } from '@/lib/utils';

type View = 'list' | 'board';

const VIEWS: readonly Segment<View>[] = [
  { value: 'list', label: 'List', icon: List },
  { value: 'board', label: 'Board', icon: Columns3 },
];

export default function ProjectScreen() {
  // The view lives in the URL rather than in state: it survives a reload, it is
  // linkable, and Back undoes the switch the way it undoes everything else.
  const { id, view } = useLocalSearchParams<{ id: string; view?: string }>();
  const [showCompleted, setShowCompleted] = useState(false);
  const tabs = useId();

  const { data: projectData, loading: projectLoading } = useQuery(ProjectDocument, {
    variables: { id: id as string },
    skip: !id,
  });
  const { data: todosData, loading: todosLoading } = useQuery(ProjectTodosDocument, {
    variables: { projectId: id as string },
    skip: !id,
  });
  const { data: lanesData } = useQuery(ProjectLanesDocument, {
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

  const project = projectData?.project;
  if (!project) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <p className="text-muted-foreground text-sm">That project doesn't exist, or isn't yours.</p>
      </div>
    );
  }

  const current: View = view === 'board' ? 'board' : 'list';
  const todos = (todosData?.todos ?? []) as TodoSummary[];
  const lanes = lanesData?.lanes ?? [];
  // Three groups, because they need three different affordances: open todos are
  // actionable now, blocked ones are not (and say why), and completed ones are
  // out of the way until asked for.
  const open = todos.filter((todo) => todo.completedAt == null && !todo.isBlocked);
  const blocked = todos.filter((todo) => todo.completedAt == null && todo.isBlocked);
  const completed = todos.filter((todo) => todo.completedAt != null);
  // Append: one past the highest position in use, so a new todo lands last.
  const nextPosition = todos.reduce((max, todo) => Math.max(max, todo.position ?? 0), -1) + 1;

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

      <TodoComposer projectId={project.id} nextPosition={nextPosition} lanes={lanes} />

      {todosLoading && todos.length === 0 ? (
        <Spinner />
      ) : current === 'board' ? (
        <div {...segmentPanelProps(tabs, 'board')}>
          <Board projectId={project.id} lanes={lanes} todos={todos} />
        </div>
      ) : (
        <div {...segmentPanelProps(tabs, 'list')} className="flex flex-col gap-6">
          <section className="flex flex-col gap-2">
            {open.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {todos.length === 0 ? 'No todos yet.' : 'Nothing open — everything is blocked or done.'}
              </p>
            ) : (
              open.map((todo) => (
                <TodoRow key={todo.id} todo={todo} projectId={project.id} siblings={todos} lanes={lanes} />
              ))
            )}
          </section>

          {blocked.length > 0 ? (
            <section className="flex flex-col gap-2">
              <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                Blocked ({blocked.length})
              </h2>
              {blocked.map((todo) => (
                <TodoRow key={todo.id} todo={todo} projectId={project.id} siblings={todos} lanes={lanes} />
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
                    <TodoRow key={todo.id} todo={todo} projectId={project.id} siblings={todos} lanes={lanes} />
                  ))
                : null}
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
