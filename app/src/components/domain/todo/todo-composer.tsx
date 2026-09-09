import { useMutation } from '@apollo/client';
import { Plus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { bumpProjectCounts, updateProjectTodos } from '@/lib/cache';
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
 */
export function TodoComposer({ projectId, nextPosition }: { projectId: string; nextPosition: number }) {
  const [title, setTitle] = useState('');
  const [createTodo, { error }] = useMutation(CreateTodoDocument);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
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
            completedAt: null,
            position: nextPosition,
            isBlocked: false,
            blockedBy: [],
            dependencies: [],
            labels: [],
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
    <form onSubmit={onSubmit} className="flex flex-col gap-1">
      <div className="flex gap-2">
        <Input
          value={title}
          placeholder="Add a todo…"
          onChange={(event) => setTitle(event.target.value)}
          aria-label="New todo"
        />
        {/* Not disabled while the write is in flight: the row is already on the
            list and the field is already empty, so the only thing waiting on the
            server would be the next todo. An empty field is what stops a
            double-submit. */}
        <Button type="submit" disabled={title.trim() === ''}>
          <Plus className="mr-1 h-4 w-4" />
          Add
        </Button>
      </div>
      {error ? <p className="text-destructive text-sm">{error.message}</p> : null}
    </form>
  );
}
