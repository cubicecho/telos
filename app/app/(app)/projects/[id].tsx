import { useQuery } from '@apollo/client';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ProjectOverview } from '@/components/domain/project/project-overview';
import { TodoComposer } from '@/components/domain/todo/todo-composer';
import { TodoRow } from '@/components/domain/todo/todo-row';
import type { TodoSummary } from '@/components/domain/todo/types';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { ProjectDocument, ProjectTodosDocument } from '@/lib/graphql';

export default function ProjectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [showCompleted, setShowCompleted] = useState(false);

  const { data: projectData, loading: projectLoading } = useQuery(ProjectDocument, {
    variables: { id: id as string },
    skip: !id,
  });
  const { data: todosData, loading: todosLoading } = useQuery(ProjectTodosDocument, {
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

  const todos = (todosData?.todos ?? []) as TodoSummary[];
  // Three groups, because they need three different affordances: open todos are
  // actionable now, blocked ones are not (and say why), and completed ones are
  // out of the way until asked for.
  const open = todos.filter((todo) => todo.completedAt == null && !todo.isBlocked);
  const blocked = todos.filter((todo) => todo.completedAt == null && todo.isBlocked);
  const completed = todos.filter((todo) => todo.completedAt != null);
  // Append: one past the highest position in use, so a new todo lands last.
  const nextPosition = todos.reduce((max, todo) => Math.max(max, todo.position ?? 0), -1) + 1;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
      <ProjectOverview project={project} />

      <TodoComposer projectId={project.id} nextPosition={nextPosition} />

      {todosLoading && todos.length === 0 ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-2">
            {open.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {todos.length === 0 ? 'No todos yet.' : 'Nothing open — everything is blocked or done.'}
              </p>
            ) : (
              open.map((todo) => <TodoRow key={todo.id} todo={todo} projectId={project.id} siblings={todos} />)
            )}
          </section>

          {blocked.length > 0 ? (
            <section className="flex flex-col gap-2">
              <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                Blocked ({blocked.length})
              </h2>
              {blocked.map((todo) => (
                <TodoRow key={todo.id} todo={todo} projectId={project.id} siblings={todos} />
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
                ? completed.map((todo) => <TodoRow key={todo.id} todo={todo} projectId={project.id} siblings={todos} />)
                : null}
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
