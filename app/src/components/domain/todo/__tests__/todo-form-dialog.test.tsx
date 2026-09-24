import { MockedProvider } from '@apollo/client/testing';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { format } from 'date-fns';
import { describe, expect, it, vi } from 'vitest';
import { UpdateTodoDocument } from '@/lib/graphql';
import { TodoFormDialog } from '../todo-form-dialog';
import type { TodoSummary } from '../types';

const TODO: TodoSummary = {
  id: 't1',
  title: 'Replace the tap',
  notes: null,
  dueAt: null,
  completedAt: null,
  position: 0,
  isBlocked: false,
  blockedBy: [],
  dependencies: [],
  labels: [],
  lane: null,
};

/**
 * The button that opens the due-date calendar. Found by its whole name, which is
 * the field's label and then its value, so a trigger that says only "Due" fails.
 */
function dueTrigger(value: string) {
  return screen.getByRole('button', { name: `Due ${value}` });
}

/** The mutation as the dialog sends it, paired with a plausible answer. */
function save(set: { title: string; notes: string | null; dueAt: string | null }) {
  return {
    request: { query: UpdateTodoDocument, variables: { id: TODO.id, set } },
    result: { data: { updateTodo: { __typename: 'Todo', id: TODO.id, ...set } } },
  };
}

function open(todo: TodoSummary, mocks: ReturnType<typeof save>[], onOpenChange = vi.fn()) {
  render(
    <MockedProvider mocks={mocks}>
      <TodoFormDialog open onOpenChange={onOpenChange} todo={todo} />
    </MockedProvider>,
  );
  return onOpenChange;
}

describe('TodoFormDialog', () => {
  it('opens showing what is stored, not a blank form', () => {
    open({ ...TODO, notes: 'The washer is perished.', dueAt: new Date(2026, 11, 1, 9).toISOString() }, []);

    expect(screen.getByLabelText('Title')).toHaveValue('Replace the tap');
    expect(screen.getByLabelText('Notes')).toHaveValue('The washer is perished.');
    // The local day, as the badge on the row shows it.
    expect(dueTrigger('December 1st, 2026')).toBeInTheDocument();
  });

  it('saves the title, the notes and the due date together, and closes', async () => {
    const user = userEvent.setup();
    // The calendar opens on this month when there is no date yet. What goes
    // over the wire is the picked day's *local* midnight — a different instant
    // in Lisbon — so the expectation is built here rather than hand-written.
    const now = new Date();
    const picked = new Date(now.getFullYear(), now.getMonth(), 15);
    const mock = save({
      title: 'Replace the kitchen tap',
      notes: 'Bring the big wrench.',
      dueAt: picked.toISOString(),
    });
    const onOpenChange = open(TODO, [mock]);

    await user.clear(screen.getByLabelText('Title'));
    await user.type(screen.getByLabelText('Title'), 'Replace the kitchen tap');
    await user.type(screen.getByLabelText('Notes'), 'Bring the big wrench.');
    await user.click(dueTrigger('No due date'));
    await user.click(await screen.findByRole('button', { name: new RegExp(format(picked, 'MMMM do, yyyy')) }));
    expect(dueTrigger(format(picked, 'PPP'))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('sends null rather than an empty string for notes nobody wrote', async () => {
    const user = userEvent.setup();
    // `notes: ''` and `notes: null` would be two stored states for one fact,
    // which is exactly what the nullable column exists to prevent.
    const onOpenChange = open({ ...TODO, notes: '   ' }, [save({ title: TODO.title, notes: null, dueAt: null })]);

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('clears a due date to null rather than to the epoch', async () => {
    const user = userEvent.setup();
    const onOpenChange = open({ ...TODO, dueAt: new Date(2026, 11, 1, 9).toISOString() }, [
      save({ title: TODO.title, notes: null, dueAt: null }),
    ]);

    await user.click(dueTrigger('December 1st, 2026'));
    await user.click(await screen.findByRole('button', { name: /clear/i }));
    expect(dueTrigger('No due date')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('refuses to save a title trimmed away to nothing', async () => {
    const user = userEvent.setup();
    const onOpenChange = open(TODO, []);

    await user.clear(screen.getByLabelText('Title'));

    // Disabled rather than failing on submit: there is no todo to be had, and
    // an empty title is not a thing the server should be asked about.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('stays open and says why when the save is refused', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <MockedProvider
        mocks={[
          {
            request: {
              query: UpdateTodoDocument,
              variables: { id: TODO.id, set: { title: TODO.title, notes: null, dueAt: null } },
            },
            result: { errors: [{ message: 'That todo is not yours.' }] },
          },
        ]}
      >
        <TodoFormDialog open onOpenChange={onOpenChange} todo={TODO} />
      </MockedProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('That todo is not yours.')).toBeInTheDocument();
    // Closing on a failure would throw away what was typed and imply it saved.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
