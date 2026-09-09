import { useMutation } from '@apollo/client';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { LabelBadge, type LabelSummary } from '@/components/domain/label/label-badge';
import { LabelPicker } from '@/components/domain/label/label-picker';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  AddTodoDependencyDocument,
  AttachTodoLabelDocument,
  CompleteTodoDocument,
  DeleteTodoDocument,
  DetachTodoLabelDocument,
  ProjectDocument,
  ProjectsDocument,
  ProjectTodosDocument,
  RemoveTodoDependencyDocument,
  ReopenTodoDocument,
} from '@/lib/graphql';
import { cn } from '@/lib/utils';
import { DependencyPicker } from './dependency-picker';
import type { TodoSummary } from './types';

export function TodoRow({
  todo,
  projectId,
  siblings,
}: {
  todo: TodoSummary;
  projectId: string;
  siblings: readonly TodoSummary[];
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Completing or deleting a todo moves the sidebar's counts and the project
  // header's, so those queries refetch alongside the list itself.
  const refetchQueries = [
    { query: ProjectTodosDocument, variables: { projectId } },
    { query: ProjectDocument, variables: { id: projectId } },
    ProjectsDocument,
  ];

  const [completeTodo] = useMutation(CompleteTodoDocument, { refetchQueries });
  const [reopenTodo] = useMutation(ReopenTodoDocument, { refetchQueries });
  const [deleteTodo] = useMutation(DeleteTodoDocument, { refetchQueries });
  const [attachLabel] = useMutation(AttachTodoLabelDocument, { refetchQueries });
  const [detachLabel] = useMutation(DetachTodoLabelDocument, { refetchQueries });
  const [addDependency] = useMutation(AddTodoDependencyDocument, { refetchQueries });
  const [removeDependency] = useMutation(RemoveTodoDependencyDocument, { refetchQueries });

  const done = todo.completedAt != null;

  async function run(action: () => Promise<unknown>) {
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Something went wrong.');
    }
  }

  function toggleDone(next: boolean) {
    return run(() =>
      next ? completeTodo({ variables: { id: todo.id } }) : reopenTodo({ variables: { id: todo.id } }),
    );
  }

  function toggleLabel(label: LabelSummary, attach: boolean) {
    return run(() =>
      attach
        ? attachLabel({ variables: { todoId: todo.id, labelId: label.id } })
        : detachLabel({ variables: { todoId: todo.id, labelId: label.id } }),
    );
  }

  function toggleDependency(dependsOnTodoId: string, add: boolean) {
    return run(() =>
      add
        ? addDependency({ variables: { todoId: todo.id, dependsOnTodoId } })
        : removeDependency({ variables: { todoId: todo.id, dependsOnTodoId } }),
    );
  }

  return (
    <div className={cn('group rounded-lg border bg-card px-3 py-2.5', todo.isBlocked && !done && 'opacity-70')}>
      <div className="flex items-start gap-3">
        <Checkbox
          checked={done}
          // A blocked todo's checkbox is disabled rather than hidden: the row
          // still says why, and the affordance stays where the eye expects it.
          disabled={todo.isBlocked && !done}
          onCheckedChange={(checked) => toggleDone(checked === true)}
          className="mt-0.5"
          aria-label={done ? `Reopen ${todo.title}` : `Complete ${todo.title}`}
        />

        <div className="min-w-0 flex-1">
          <p className={cn('text-sm', done && 'text-muted-foreground line-through')}>{todo.title}</p>

          {todo.isBlocked && !done ? (
            <p className="mt-1 text-muted-foreground text-xs">
              Blocked by {todo.blockedBy.map((blocker) => blocker.title).join(', ')}
            </p>
          ) : null}

          {todo.labels.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {todo.labels.map((label) => (
                <LabelBadge key={label.id} label={label} onRemove={() => toggleLabel(label, false)} />
              ))}
            </div>
          ) : null}

          {actionError ? <p className="mt-1 text-destructive text-xs">{actionError}</p> : null}
        </div>

        {/* Every action the row offers, in one cluster that appears together on
            hover. `has-[[data-state=open]]` keeps it visible while a picker's
            popover is open: Radix renders that panel in a portal, so
            `focus-within` alone would let the cluster fade out from under the
            panel the reader is using. */}
        <div className="flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 has-[[data-state=open]]:opacity-100">
          <LabelPicker attached={todo.labels} onToggle={toggleLabel} align="end" className="h-8 w-8" />
          <DependencyPicker
            todo={todo}
            candidates={siblings}
            onToggle={toggleDependency}
            align="end"
            className="h-8 w-8"
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            onClick={() => setConfirmingDelete(true)}
            aria-label={`Delete ${todo.title}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this todo?</AlertDialogTitle>
            <AlertDialogDescription>
              “{todo.title}” and any dependency links to it are removed. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => run(() => deleteTodo({ variables: { id: todo.id } }))}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
