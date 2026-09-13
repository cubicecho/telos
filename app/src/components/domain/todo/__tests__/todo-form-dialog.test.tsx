import { MockedProvider } from '@apollo/client/testing';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { fromDateInputValue } from '@/lib/dates';
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
    open({ ...TODO, notes: 'The washer is perished.', dueAt: '2026-12-01T09:00:00.000Z' }, []);

    expect(screen.getByLabelText('Title')).toHaveValue('Replace the tap');
    expect(screen.getByLabelText('Notes')).toHaveValue('The washer is perished.');
    // The date input wants a local `yyyy-mm-dd`, which is the whole reason
    // `toDateInputValue` exists rather than a `toISOString().slice(0, 10)`.
    expect(screen.getByLabelText('Due')).toHaveValue('2026-12-01');
  });

  it('saves the title, the notes and the due date together, and closes', async () => {
    const user = userEvent.setup();
    // MockedProvider matches variables by deep equality, so the expected
    // `dueAt` is built by the same function the dialog uses rather than
    // hand-written: a date input names a local day, and what goes over the wire
    // is that day's midnight here — which is a different instant in Lisbon.
    const mock = save({
      title: 'Replace the kitchen tap',
      notes: 'Bring the big wrench.',
      dueAt: fromDateInputValue('2026-12-01'),
    });
    const onOpenChange = open(TODO, [mock]);

    await user.clear(screen.getByLabelText('Title'));
    await user.type(screen.getByLabelText('Title'), 'Replace the kitchen tap');
    await user.type(screen.getByLabelText('Notes'), 'Bring the big wrench.');
    await user.type(screen.getByLabelText('Due'), '2026-12-01');
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
    const onOpenChange = open({ ...TODO, dueAt: '2026-12-01T09:00:00.000Z' }, [
      save({ title: TODO.title, notes: null, dueAt: null }),
    ]);

    await user.clear(screen.getByLabelText('Due'));
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
