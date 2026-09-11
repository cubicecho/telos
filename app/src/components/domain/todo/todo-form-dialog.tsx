import { useMutation } from '@apollo/client';
import { type FormEvent, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { fromDateInputValue, toDateInputValue } from '@/lib/dates';
import { describeError } from '@/lib/errors';
import { UpdateTodoDocument } from '@/lib/graphql';
import type { TodoSummary } from './types';

/**
 * Editing a todo, which until now was the one thing in Telos you could not do.
 *
 * Modelled on `ProjectFormDialog`, minus the create half: a todo is created by
 * the inline composer, which takes a title and nothing else, so this dialog only
 * ever edits. The three fields here are the whole of what an edit may touch —
 * the lane, labels, dependencies and completion each have their own affordance
 * on the row, and each carries invariants a free-form form would have to
 * re-state.
 *
 * No `update` function, unusually for this app. The other todo mutations write
 * a cache updater because completing or deleting moves *other* rows — the
 * project's counts, the list's membership. An edit moves none: `Todo` is
 * normalized by id, so the mutation's own result settles the row in the list,
 * on the board, and in every "Blocked by …" line that names it.
 */
export function TodoFormDialog({
  open,
  onOpenChange,
  todo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  todo: TodoSummary;
}) {
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [updateTodo, { loading, error }] = useMutation(UpdateTodoDocument);

  // Reset from the todo each time it opens, not on mount: the dialog outlives a
  // cancel, so a reopened form must show what is stored rather than what was
  // last typed and abandoned.
  useEffect(() => {
    if (!open) return;
    setTitle(todo.title);
    setNotes(todo.notes ?? '');
    setDueAt(toDateInputValue(todo.dueAt));
  }, [open, todo]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (trimmed === '') return;
    // Empty means absent, for both: the columns are nullable precisely so that
    // "no notes" and "an empty note" cannot be two different stored states.
    const set = {
      title: trimmed,
      notes: notes.trim() === '' ? null : notes.trim(),
      dueAt: fromDateInputValue(dueAt),
    };

    try {
      await updateTodo({
        variables: { id: todo.id, set },
        optimisticResponse: { updateTodo: { __typename: 'Todo', id: todo.id, ...set } },
      });
    } catch {
      // The mutation rejects as well as setting `error`, so an uncaught await
      // here is both an unhandled rejection and a dialog that stays open with
      // no explanation of why. Stay open — deliberately — but say so: what was
      // typed is still in the fields, ready to send again.
      return;
    }
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit todo</DialogTitle>
          <DialogDescription>
            Its lane, labels and dependencies are set from the row itself, where the rules about them live.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="todo-title">Title</Label>
            <Input
              id="todo-title"
              autoFocus
              value={title}
              placeholder="Replace the tap"
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="todo-notes">Notes</Label>
            <Textarea
              id="todo-notes"
              value={notes}
              placeholder="Optional."
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="todo-due-at">Due</Label>
            {/* A native date input rather than a calendar component: it is
                keyboard-accessible, localized and clearable for free, and the
                app has no date picker to reuse. Clearing it is the path the
                server-side scalar override exists to keep honest. */}
            <Input
              id="todo-due-at"
              type="date"
              value={dueAt}
              onChange={(event) => setDueAt(event.target.value)}
              className="w-fit"
            />
          </div>
          {error ? (
            <p className="text-destructive text-sm" aria-live="polite">
              {describeError(error)}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading || title.trim() === ''}>
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
