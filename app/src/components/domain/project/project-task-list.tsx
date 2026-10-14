import { useQuery } from '@apollo/client';
import { Link } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { LaneTodoComposer } from '@/components/domain/lane/lane-todo-composer';
import { TodoRow } from '@/components/domain/todo/todo-row';
import type { TodoSummary } from '@/components/domain/todo/types';
import { useCreateTodo } from '@/components/domain/todo/use-create-todo';
import { Section } from '@/components/section';
import { Button } from '@/components/ui/button';
import { LoadState } from '@/components/ui/load-failure';
import { describeError } from '@/lib/errors';
import { ProjectLanesDocument, ProjectTodosDocument } from '@/lib/graphql';
import { CARD_TITLE } from '@/lib/styles';

/**
 * One project as a plain list, for the overview: what is open, a field to add
 * to it, and what is done folded away. No lanes and no filter; the project's
 * own page has those, a click on the title away.
 *
 * It reads the same queries the project page does, so a tick or a new todo
 * here is the same cache write, and the page is already current when opened.
 */
export function ProjectTaskList({ project }: { project: { id: string; name: string } }) {
  const todosQuery = useQuery(ProjectTodosDocument, { variables: { projectId: project.id } });
  const lanesQuery = useQuery(ProjectLanesDocument, { variables: { projectId: project.id } });
  const [showCompleted, setShowCompleted] = useState(false);
  const lanes = lanesQuery.data?.lanes ?? [];
  const { create, error } = useCreateTodo(project.id, lanes);

  const all = (todosQuery.data?.todos ?? []) as TodoSummary[];
  // Blocked todos stay with the open ones: here the list is what is left to
  // do, and the row already says what it waits on.
  const open = all.filter((todo) => todo.completedAt == null);
  const completed = all.filter((todo) => todo.completedAt != null);
  const nextPosition = all.reduce((max, todo) => Math.max(max, todo.position ?? 0), -1) + 1;

  return (
    <Section
      surface="card"
      titleClassName={CARD_TITLE}
      title={
        <Link href={`/projects/${project.id}`} className="text-foreground no-underline hover:underline">
          {project.name}
        </Link>
      }
      contentSlot={
        <View className="gap-2">
          <LoadState query={todosQuery} what="these todos" count={all.length} compact emptySlot={null} />
          {todosQuery.data ? (
            <>
              {open.length === 0 ? (
                <Text className="text-foreground/60 text-sm">
                  {all.length === 0 ? 'No todos yet.' : 'Nothing open.'}
                </Text>
              ) : (
                open.map((todo) => (
                  <TodoRow key={todo.id} todo={todo} projectId={project.id} siblings={all} lanes={lanes} />
                ))
              )}
              <LaneTodoComposer
                laneName={project.name}
                // The hook reports a failure through `error`; the title is not
                // handed back, as there is no field left open to put it in.
                onCreate={(title) => void create(title, nextPosition).catch(() => undefined)}
              />
              {error ? (
                <Text className="text-negative text-sm" aria-live="polite">
                  {describeError(error)}
                </Text>
              ) : null}
              {completed.length > 0 ? (
                <View className="gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="self-start text-foreground/60"
                    aria-expanded={showCompleted}
                    onPress={() => setShowCompleted((shown) => !shown)}
                    content={`${showCompleted ? 'Hide' : 'Show'} completed (${completed.length})`}
                  />
                  {showCompleted
                    ? completed.map((todo) => (
                        <TodoRow key={todo.id} todo={todo} projectId={project.id} siblings={all} lanes={lanes} />
                      ))
                    : null}
                </View>
              ) : null}
            </>
          ) : null}
        </View>
      }
    />
  );
}
