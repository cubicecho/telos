import { type ApolloCache, useMutation } from '@apollo/client';
import { useState } from 'react';
import { Pressable, Text, View, type ViewProps } from 'react-native';
import { AiIgnoredBadge } from '@/components/domain/ai/ai-ignored-badge';
import { LabelBadge, type LabelSummary } from '@/components/domain/label/label-badge';
import { LabelPicker } from '@/components/domain/label/label-picker';
import { LaneBadge } from '@/components/domain/lane/lane-badge';
import { LanePicker } from '@/components/domain/lane/lane-picker';
import { useMoveTodo } from '@/components/domain/lane/use-move-todo';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Pencil, Trash2 } from '@/components/ui/icons';
import { bumpProjectCounts, type CachedLane, laneForCompletion, updateProjectTodos } from '@/lib/cache';
import { describeError } from '@/lib/errors';
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
import { cn, HOVER_REVEAL } from '@/lib/utils';
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
      setActionError(describeError(error));
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

  function onRowKeyDown(event: KeyboardEvent) {
    if (event.key !== 'e' || event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTyping(event.target)) return;
    event.preventDefault();
    setEditing(true);
  }

  return (
    // `e` edits, scoped to the row rather than the document, because "the
    // focused todo" is a fact only the row knows. Any focused child counts —
    // the checkbox, the title, an action — since all of them are unambiguously
    // *this* todo. Radix portals its popovers out of here, so an open picker
    // never sees it. (`onKeyDown` is web-only; react-native-web forwards it to
    // the `<div>`, and there is no hardware-key equivalent on device.)
    // `role="group"` because that is what the row is — a named cluster of
    // controls acting on one todo.
    <View
      role="group"
      aria-label={todo.title}
      // Spread and cast because React Native's `ViewProps` does not declare the
      // DOM keyboard props react-native-web forwards.
      {...({ onKeyDown: onRowKeyDown } as ViewProps)}
      className={cn(
        'group rounded-lg border border-border bg-card px-3 py-2.5',
        todo.isBlocked && !done && 'opacity-70',
      )}
    >
      <View className="flex-row items-start gap-3">
        <Checkbox
          checked={done}
          // A blocked todo's checkbox is disabled rather than hidden: the row
          // still says why, and the affordance stays where the eye expects it.
          disabled={todo.isBlocked && !done}
          onCheckedChange={toggleDone}
          accessibilityLabel={done ? `Reopen ${todo.title}` : `Complete ${todo.title}`}
          className="mt-0.5"
        />

        <View className="min-w-0 flex-1">
          {/* The lane sits with the title rather than below it, so the list
              reads as one line per todo and still says which column it is in. */}
          <View className="flex-row items-start gap-2">
            {/* Pressable rather than text: the title is how a todo is opened,
                and until it was one it was not reachable by keyboard at all.
                Styled flat so the row still reads as text — the affordance is
                the hover underline and the focus ring, not a control. */}
            <Pressable
              role="button"
              onPress={() => setEditing(true)}
              className="min-w-0 flex-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            >
              <Text
                className={cn(
                  'text-foreground text-sm leading-5 hover:underline',
                  done && 'text-muted-foreground line-through',
                )}
              >
                {todo.title}
              </Text>
            </Pressable>
            <DueBadge dueAt={todo.dueAt} done={done} className="mt-px" />
            {todo.lane && !todo.lane.isDone ? <LaneBadge lane={todo.lane} className="mt-px" /> : null}
            <AiIgnoredBadge ignored={todo.aiIgnored} className="mt-px" />
          </View>

          {/* One line of the notes, because their presence is otherwise
              invisible — a todo with a paragraph behind it looks exactly like
              one without. */}
          {todo.notes ? (
            <Text numberOfLines={1} className="mt-1 text-muted-foreground text-xs">
              {todo.notes}
            </Text>
          ) : null}

          {todo.isBlocked && !done ? (
            <Text className="mt-1 text-muted-foreground text-xs">
              Blocked by {todo.blockedBy.map((blocker) => blocker.title).join(', ')}
            </Text>
          ) : null}

          {todo.labels.length > 0 ? (
            <View className="mt-2 flex-row flex-wrap gap-1">
              {todo.labels.map((label) => (
                <LabelBadge key={label.id} label={label} onRemove={() => toggleLabel(label, false)} />
              ))}
            </View>
          ) : null}

          {actionError ? (
            <Text className="mt-1 text-destructive text-xs" aria-live="polite">
              {actionError}
            </Text>
          ) : null}
        </View>

        {/* Every action the row offers, in one cluster that appears together on
            hover or focus (`HOVER_REVEAL` — always shown off web). An open
            picker's popover is portalled, so the cluster may fade behind it;
            the old `has-[[data-state=open]]` guard read a radix attribute that
            react-native-web does not forward onto a `Pressable`. */}
        <View className={cn('h-5 shrink-0 flex-row items-center focus-within:opacity-100', HOVER_REVEAL)}>
          <Button variant="ghost" size="icon-xs" onPress={() => setEditing(true)} aria-label={`Edit ${todo.title}`}>
            <Pencil className="h-4 w-4" />
          </Button>
          <LanePicker
            lanes={lanes}
            current={todo.lane}
            onSelect={moveToLane}
            lockedReason={laneLock(todo)}
            align="end"
            size="icon-xs"
          />
          <LabelPicker attached={todo.labels} onToggle={toggleLabel} align="end" size="icon-xs" />
          <DependencyPicker todo={todo} candidates={siblings} onToggle={toggleDependency} align="end" size="icon-xs" />
          <Button
            variant="ghost"
            size="icon-xs"
            className="hover:text-destructive"
            onPress={() => setConfirmingDelete(true)}
            aria-label={`Delete ${todo.title}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </View>
      </View>

      <TodoFormDialog open={editing} onOpenChange={setEditing} todo={todo} />

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title="Delete this todo?"
        description={`“${todo.title}” and any dependency links to it are removed. This cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={() => {
          // ConfirmDialog leaves closing to the caller; AlertDialogAction used
          // to close on its own.
          setConfirmingDelete(false);
          void remove();
        }}
      />
    </View>
  );
}
