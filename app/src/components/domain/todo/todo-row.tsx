import { type ApolloCache, useMutation } from '@apollo/client';
import { Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { LabelBadge, type LabelSummary } from '@/components/domain/label/label-badge';
import { LabelPicker } from '@/components/domain/label/label-picker';
import { LaneBadge } from '@/components/domain/lane/lane-badge';
import { LanePicker } from '@/components/domain/lane/lane-picker';
import { useMoveTodo } from '@/components/domain/lane/use-move-todo';
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
import { bumpProjectCounts, type CachedLane, laneForCompletion, updateProjectTodos } from '@/lib/cache';
import {
  AddTodoDependencyDocument,
  AttachTodoLabelDocument,
  CompleteTodoDocument,
  DeleteTodoDocument,
  DetachTodoLabelDocument,
  RemoveTodoDependencyDocument,
  ReopenTodoDocument,
} from '@/lib/graphql';
import { isTyping } from '@/lib/hotkeys';
import { laneLock } from '@/lib/lanes';
import { cn } from '@/lib/utils';
import { DependencyPicker } from './dependency-picker';
import { DueBadge } from './due-badge';
import { TodoFormDialog } from './todo-form-dialog';
import type { TodoSummary } from './types';

export function TodoRow({
  todo,
  projectId,
  siblings,
  lanes,
}: {
  todo: TodoSummary;
  projectId: string;
  siblings: readonly TodoSummary[];
  lanes: readonly CachedLane[];
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Nothing here refetches. Completing and deleting are arithmetic the client
  // can do itself; labels and dependencies are junction-table writes, and those
  // mutations return the whole todo, so Apollo normalizes the answer into every
  // list already holding it.
  const [completeTodo] = useMutation(CompleteTodoDocument);
  const [reopenTodo] = useMutation(ReopenTodoDocument);
  const [deleteTodo] = useMutation(DeleteTodoDocument);
  const [attachLabel] = useMutation(AttachTodoLabelDocument);
  const [detachLabel] = useMutation(DetachTodoLabelDocument);
  const [addDependency] = useMutation(AddTodoDependencyDocument);
  const [removeDependency] = useMutation(RemoveTodoDependencyDocument);
  const moveTodo = useMoveTodo(projectId);

  const done = todo.completedAt != null;

  /**
   * Write a completion — or its undo — into the cache.
   *
   * Runs twice per mutation: once for the optimistic response and once for the
   * server's. Apollo discards the optimistic layer before the second, so the
   * count delta lands exactly once, and the list rewrite is idempotent.
   */
  function writeCompletion(cache: ApolloCache<unknown>, completedAt: string | null, lane: CachedLane | null) {
    updateProjectTodos(cache, projectId, (todos) =>
      todos.map((row) => (row.id === todo.id ? { ...row, completedAt, lane: lane ?? row.lane } : row)),
    );
    // Blocked todos count as open, so only the tick moves the number.
    bumpProjectCounts(cache, projectId, { total: 0, open: completedAt == null ? 1 : -1 });
  }

  async function run(action: () => Promise<unknown>) {
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Something went wrong.');
    }
  }

  function toggleDone(next: boolean) {
    // The server stamps its own clock; this one only has to be a timestamp so
    // the row reads as done, and it is replaced by the real one milliseconds
    // later. Nothing is displayed from it.
    const completedAt = next ? new Date().toISOString() : null;
    // Ticking the box is also a move on the board: the server sends the todo to
    // the done lane, or back to the first open one, and the optimistic row has
    // to name the same column or the card would jump when the answer lands.
    const lane = laneForCompletion(lanes, completedAt);
    return run(() =>
      next
        ? completeTodo({
            variables: { id: todo.id },
            optimisticResponse: {
              completeTodo: { __typename: 'Todo', id: todo.id, completedAt, isBlocked: todo.isBlocked, lane },
            },
            update: (cache, { data }) => {
              if (data?.completeTodo) writeCompletion(cache, data.completeTodo.completedAt, data.completeTodo.lane);
            },
          })
        : reopenTodo({
            variables: { id: todo.id },
            optimisticResponse: {
              reopenTodo: { __typename: 'Todo', id: todo.id, completedAt: null, isBlocked: todo.isBlocked, lane },
            },
            update: (cache, { data }) => {
              if (data?.reopenTodo) writeCompletion(cache, data.reopenTodo.completedAt, data.reopenTodo.lane);
            },
          }),
    );
  }

  function remove() {
    return run(() =>
      deleteTodo({
        variables: { id: todo.id },
        optimisticResponse: { deleteTodo: { __typename: 'Todo', id: todo.id } },
        update(cache, { data }) {
          if (!data?.deleteTodo) return;
          updateProjectTodos(cache, projectId, (todos) => todos.filter((row) => row.id !== todo.id));
          bumpProjectCounts(cache, projectId, { total: -1, open: done ? 0 : -1 });
          // The row is out of every list that named it; drop the entity too,
          // or it sits in the cache for the rest of the session.
          cache.evict({ id: cache.identify({ __typename: 'Todo', id: todo.id }) });
        },
      }),
    );
  }

  function toggleLabel(label: LabelSummary, attach: boolean) {
    return run(() =>
      attach
        ? attachLabel({ variables: { todoId: todo.id, labelId: label.id } })
        : detachLabel({ variables: { todoId: todo.id, labelId: label.id } }),
    );
  }

  function moveToLane(lane: CachedLane) {
    return run(() => moveTodo(todo, lane));
  }

  function toggleDependency(dependsOnTodoId: string, add: boolean) {
    return run(() =>
      add
        ? addDependency({ variables: { todoId: todo.id, dependsOnTodoId } })
        : removeDependency({ variables: { todoId: todo.id, dependsOnTodoId } }),
    );
  }

  return (
    // `e` edits, scoped to the row rather than the document, because "the
    // focused todo" is a fact only the row knows. Any focused child counts —
    // the checkbox, the title, an action — since all of them are unambiguously
    // *this* todo. Radix portals its popovers out of here, so an open picker
    // never sees it.
    // `role="group"` because that is what the row is — a named cluster of
    // controls acting on one todo — and it is what lets the key handler sit
    // here without pretending the div is a control of its own. Not the
    // `<fieldset>` the linter suggests: that groups form inputs under a legend,
    // and this is a row of a list.
    // biome-ignore lint/a11y/useSemanticElements: see above
    <div
      role="group"
      aria-label={todo.title}
      onKeyDown={(event) => {
        if (event.key !== 'e' || event.metaKey || event.ctrlKey || event.altKey) return;
        if (isTyping(event.target)) return;
        event.preventDefault();
        setEditing(true);
      }}
      className={cn('group rounded-lg border bg-card px-3 py-2.5', todo.isBlocked && !done && 'opacity-70')}
    >
      <div className="flex items-start gap-3">
        <Checkbox
          checked={done}
          // A blocked todo's checkbox is disabled rather than hidden: the row
          // still says why, and the affordance stays where the eye expects it.
          disabled={todo.isBlocked && !done}
          onCheckedChange={(checked) => toggleDone(checked === true)}
          aria-label={done ? `Reopen ${todo.title}` : `Complete ${todo.title}`}
        />

        <div className="min-w-0 flex-1">
          {/* `leading-5` pins the first line's height to the checkbox's, so the
              two agree even if a theme changes the base line height. */}
          {/* The lane sits with the title rather than below it, so the list
              reads as one line per todo and still says which column it is in. */}
          <div className="flex items-start gap-2">
            {/* A button rather than a <p>: the title is how a todo is opened,
                and until it was one it was not reachable by keyboard at all.
                Styled flat so the row still reads as text — the affordance is
                the hover underline and the focus ring, not a control. */}
            <button
              type="button"
              onClick={() => setEditing(true)}
              className={cn(
                'min-w-0 flex-1 rounded-sm text-left text-sm leading-5 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                done && 'text-muted-foreground line-through',
              )}
            >
              {todo.title}
            </button>
            <DueBadge dueAt={todo.dueAt} done={done} className="mt-px" />
            {todo.lane && !todo.lane.isDone ? <LaneBadge lane={todo.lane} className="mt-px" /> : null}
          </div>

          {/* One line of the notes, because their presence is otherwise
              invisible — a todo with a paragraph behind it looks exactly like
              one without. */}
          {todo.notes ? <p className="mt-1 truncate text-muted-foreground text-xs">{todo.notes}</p> : null}

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

          {actionError ? (
            <p className="mt-1 text-destructive text-xs" aria-live="polite">
              {actionError}
            </p>
          ) : null}
        </div>

        {/* Every action the row offers, in one cluster that appears together on
            hover. `has-[[data-state=open]]` keeps it visible while a picker's
            popover is open: Radix renders that panel in a portal, so
            `focus-within` alone would let the cluster fade out from under the
            panel the reader is using. */}
        <div className="flex h-5 shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 has-[[data-state=open]]:opacity-100">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground"
            onClick={() => setEditing(true)}
            aria-label={`Edit ${todo.title}`}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <LanePicker
            lanes={lanes}
            current={todo.lane}
            onSelect={moveToLane}
            lockedReason={laneLock(todo)}
            align="end"
            className="h-8 w-8"
          />
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

      <TodoFormDialog open={editing} onOpenChange={setEditing} todo={todo} />

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
              onClick={remove}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
