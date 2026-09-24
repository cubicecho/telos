import { useMutation } from '@apollo/client';
import { useEffect } from 'react';
import { useAppForm } from '@/components/app-form';
import { Form } from '@/components/ui/form';
import { FormDialog, FormDialogFooter } from '@/components/ui/form-dialog';
import { parseDate } from '@/lib/dates';
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
  const [updateTodo, { error }] = useMutation(UpdateTodoDocument);
  const form = useAppForm({
    defaultValues: { title: '', notes: '', dueAt: null as Date | null },
    onSubmit: ({ value }) => save(value),
  });

  // Reset from the todo each time it opens, not on mount: the dialog outlives a
  // cancel, so a reopened form must show what is stored rather than what was
  // last typed and abandoned.
  useEffect(() => {
    if (!open) return;
    form.reset({ title: todo.title, notes: todo.notes ?? '', dueAt: parseDate(todo.dueAt) ?? null });
  }, [open, todo, form]);

  async function save({ title, notes, dueAt }: { title: string; notes: string; dueAt: Date | null }) {
    const trimmed = title.trim();
    // Empty means absent, for both: the columns are nullable precisely so that
    // "no notes" and "an empty note" cannot be two different stored states.
    const set = {
      title: trimmed,
      notes: notes.trim() === '' ? null : notes.trim(),
      dueAt: dueAt ? dueAt.toISOString() : null,
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
      <form.AppForm>
        <Form className="gap-4">
          <form.AppField
            name="title"
            validators={{ onChange: ({ value }) => (value.trim() === '' ? 'A todo needs a title.' : undefined) }}
          >
            {(field) => <field.InputField label="Title" autoFocus placeholder="Replace the tap" />}
          </form.AppField>
          <form.AppField name="notes">
            {(field) => <field.TextAreaField label="Notes" placeholder="Optional." />}
          </form.AppField>
          {/* Date only: a picked day is committed at local midnight, so the day
              the reader chose is the day they get back in their own zone. Clear
              saves `null`, never the epoch, which is the path the server-side
              scalar override exists to keep honest. */}
          <form.AppField name="dueAt">
            {(field) => (
              <field.DateTimeField
                label="Due"
                mode="date"
                placeholder="No due date"
                clearable
                description="Clear it from the calendar for no due date."
              />
            )}
          </form.AppField>
          <FormDialogFooter onCancel={() => onOpenChange(false)} error={error ? describeError(error) : null}>
            <form.SubmitButton isEdit editLabel="Save" />
          </FormDialogFooter>
        </Form>
      </form.AppForm>
    </FormDialog>
  );
}
