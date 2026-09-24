import { useMutation } from '@apollo/client';
import { useEffect, useMemo, useState } from 'react';
import { useAppForm } from '@/components/app-form';
import { Form } from '@/components/ui/form';
import { FormDialog, FormDialogFooter } from '@/components/ui/form-dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAi } from '@/lib/ai';
import { parseDate } from '@/lib/dates';
import { describeError } from '@/lib/errors';
import { UpdateTodoDocument } from '@/lib/graphql';
import { TodoHistory, TodoThread } from './todo-record';
import type { TodoSummary } from './types';

/**
 * Editing a todo, which until now was the one thing in Telos you could not do.
 *
 * Modelled on `ProjectFormDialog`, minus the create half: a todo is created by
 * the inline composer, which takes a title and nothing else, so this dialog only
 * ever edits. The fields here are the whole of what an edit may touch —
 * the lane, labels, dependencies and completion each have their own affordance
 * on the row, and each carries invariants a free-form form would have to
 * re-state.
 *
 * Beside the form, the todo's record: its notes thread and its history, each a
 * tab, loaded only when opened. "AI ignores this" is the one AI field, drawn —
 * and sent — only while AI is on for the account.
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
  const ai = useAi();
  const [tab, setTab] = useState('details');
  const [updateTodo, { error }] = useMutation(UpdateTodoDocument);
  // The todo as the form holds it, and so the form's defaults as well as what
  // it resets to. Both matter: TanStack re-applies `defaultValues` whenever they
  // change on a render of an untouched form, so blank literals here would wipe
  // the reset below the moment anything re-rendered the dialog — `useAi`
  // answering, say.
  const initial = useMemo(
    () => ({
      title: todo.title,
      notes: todo.notes ?? '',
      acceptance: todo.acceptance ?? '',
      dueAt: parseDate(todo.dueAt) ?? null,
      aiIgnored: todo.aiIgnored,
    }),
    [todo],
  );
  const form = useAppForm({
    defaultValues: initial,
    onSubmit: ({ value }) => save(value),
  });

  // Reset from the todo each time it opens, not on mount: the dialog outlives a
  // cancel, so a reopened form must show what is stored rather than what was
  // last typed and abandoned.
  useEffect(() => {
    if (!open) return;
    setTab('details');
    form.reset(initial);
  }, [open, initial, form]);

  async function save(value: {
    title: string;
    notes: string;
    acceptance: string;
    dueAt: Date | null;
    aiIgnored: boolean;
  }) {
    // Empty means absent: the columns are nullable precisely so that "no notes"
    // and "an empty note" cannot be two different stored states.
    const orNull = (text: string) => (text.trim() === '' ? null : text.trim());
    const set = {
      title: value.title.trim(),
      notes: orNull(value.notes),
      acceptance: orNull(value.acceptance),
      dueAt: value.dueAt ? value.dueAt.toISOString() : null,
      // Only while AI is on: off, the flag is not this form's to change.
      ...(ai.on ? { aiIgnored: value.aiIgnored } : {}),
    };

    try {
      await updateTodo({
        variables: { id: todo.id, set },
        optimisticResponse: {
          updateTodo: { __typename: 'Todo', id: todo.id, aiIgnored: todo.aiIgnored, ...set },
        },
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
      className="sm:max-w-[560px]"
    >
      <Tabs value={tab} onValueChange={setTab} className="gap-4">
        <TabsList aria-label="Todo" className="self-start">
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="notes">Thread</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="details">
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
              <form.AppField name="acceptance">
                {(field) => (
                  <field.TextAreaField label="Acceptance criteria" placeholder="Optional. What done looks like." />
                )}
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
              {ai.on ? (
                <form.AppField name="aiIgnored">
                  {(field) => (
                    <field.CheckboxField
                      label="AI ignores this"
                      description="No agent picks it up, and AI clients cannot read it."
                    />
                  )}
                </form.AppField>
              ) : null}
              <FormDialogFooter onCancel={() => onOpenChange(false)} error={error ? describeError(error) : null}>
                <form.SubmitButton isEdit editLabel="Save" />
              </FormDialogFooter>
            </Form>
          </form.AppForm>
        </TabsContent>
        <TabsContent value="notes">
          <TodoThread todoId={todo.id} />
        </TabsContent>
        <TabsContent value="history">
          <TodoHistory todoId={todo.id} />
        </TabsContent>
      </Tabs>
    </FormDialog>
  );
}
