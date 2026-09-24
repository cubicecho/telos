import { useMutation } from '@apollo/client';
import { forwardRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons';
import type { InputHandle } from '@/components/ui/input';
import { Input } from '@/components/ui/input';
import { bumpProjectCounts, type CachedLane, laneForCompletion, updateProjectTodos } from '@/lib/cache';
import { describeError } from '@/lib/errors';
import { CreateTodoDocument } from '@/lib/graphql';
import { newId } from '@/lib/ids';

/**
 * Adding a todo is a title and nothing else, so it is an inline field rather
 * than a dialog — the cost of capturing one should be a sentence and Enter.
 *
 * And it should cost no waiting either: the row is written to the cache before
 * the request leaves, from an id minted here. Apollo replaces that entry with
 * the server's when it answers and rolls it back if the write fails, so the
 * only state this has to undo by hand is the emptied field.
 *
 * The ref goes to the field, so `n` can focus it from anywhere on the screen.
 * It is cubeui's `InputHandle` rather than the DOM element: `focus()` is all
 * the hotkey needs, and it is the part both platforms can promise.
 */
export const TodoComposer = forwardRef<
  InputHandle,
  {
    projectId: string;
    nextPosition: number;
    lanes: readonly CachedLane[];
  }
>(function TodoComposer({ projectId, nextPosition, lanes }, ref) {
  const [title, setTitle] = useState('');
  const [createTodo, { error }] = useMutation(CreateTodoDocument);

  async function onSubmit() {
    const trimmed = title.trim();
    if (trimmed === '') return;

    const id = newId();
    // Cleared now rather than after the round trip, so the next todo can be
    // typed immediately. Put back below if the write turns out to have failed.
    setTitle('');

    try {
      await createTodo({
        variables: { values: { id, projectId, title: trimmed, position: nextPosition } },
        // A new todo is open, unblocked and bare — every field the list reads is
        // known here, so nothing about this row is a guess except that it will
        // be accepted.
        optimisticResponse: {
          createTodo: {
            __typename: 'Todo',
            id,
            title: trimmed,
            // The composer takes a title and nothing else; both are set from
            // the edit dialog, never from here.
            notes: null,
            acceptance: null,
            aiIgnored: false,
            parentId: null,
            dueAt: null,
            completedAt: null,
            position: nextPosition,
            isBlocked: false,
            blockedBy: [],
            dependencies: [],
            labels: [],
            // A new todo is open, so it belongs in the first open column —
            // the same lane the server's realignment will put it in.
            lane: laneForCompletion(lanes, null),
          },
        },
        update(cache, { data }) {
          const todo = data?.createTodo;
          if (!todo) return;
          // Filtered before appending: the list may already hold this id if a
          // refetch landed first, and the query orders by position, so the end
          // is where a todo with the highest one belongs.
          updateProjectTodos(cache, projectId, (todos) => [...todos.filter((row) => row.id !== todo.id), todo]);
          bumpProjectCounts(cache, projectId, { total: 1, open: 1 });
        },
      });
    } catch {
      // The message is already on screen via `error`; this hands back what was
      // typed so it does not have to be typed again.
      setTitle(trimmed);
    }
  }

  return (
    <View className="gap-1">
      <View className="flex-row gap-2">
        {/* Enter submits through `onSubmitEditing`: there is no `<form>` here,
            which is the one shape both platforms agree on. */}
        <Input
          ref={ref}
          // Named without a visible label: the placeholder already says it.
          aria-label="New todo"
          value={title}
          placeholder="Add a todo…  (press n)"
          onChangeText={setTitle}
          onSubmitEditing={onSubmit}
          className="flex-1"
        />
        {/* Not disabled while the write is in flight: the row is already on the
            list and the field is already empty, so the only thing waiting on the
            server would be the next todo. An empty field is what stops a
            double-submit. */}
        <Button onPress={onSubmit} disabled={title.trim() === ''}>
          <Plus className="mr-1 h-4 w-4" />
          Add
        </Button>
      </View>
      {error ? (
        <Text className="text-destructive text-sm" aria-live="polite">
          {describeError(error)}
        </Text>
      ) : null}
    </View>
  );
});
