import { useMutation } from '@apollo/client';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { FormDialog, FormDialogFooter } from '@/components/ui/form-dialog';
import { Input } from '@/components/ui/input';
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

  const canSave = !loading && title.trim() !== '';

  async function onSubmit() {
    const trimmed = title.trim();
    if (!canSave) return;
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
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit todo"
      description="Its lane, labels and dependencies are set from the row itself, where the rules about them live."
    >
      <View className="gap-4">
        <Field>
          <FieldLabel htmlFor="todo-title">Title</FieldLabel>
          <Input
            id="todo-title"
            autoFocus
            value={title}
            placeholder="Replace the tap"
            onChangeText={setTitle}
            onSubmitEditing={onSubmit}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="todo-notes">Notes</FieldLabel>
          <Textarea id="todo-notes" value={notes} placeholder="Optional." onChangeText={setNotes} />
        </Field>
        <Field>
          <FieldLabel htmlFor="todo-due-at">Due</FieldLabel>
          {/* A native date input rather than a calendar component: it is
              keyboard-accessible, localized and clearable for free. Clearing it
              is the path the server-side scalar override exists to keep honest:
              an empty field saves `null`, never the epoch. cubeui has no
              optional date-only input yet: cubicecho/cubeui#88. */}
          <Input
            id="todo-due-at"
            type="date"
            value={dueAt}
            onChangeText={setDueAt}
            onSubmitEditing={onSubmit}
            className="w-40"
          />
          <FieldDescription>Empty for no due date.</FieldDescription>
        </Field>
      </View>
      <FormDialogFooter onCancel={() => onOpenChange(false)} error={error ? describeError(error) : null}>
        <Button onPress={onSubmit} disabled={!canSave}>
          Save
        </Button>
      </FormDialogFooter>
    </FormDialog>
  );
}
