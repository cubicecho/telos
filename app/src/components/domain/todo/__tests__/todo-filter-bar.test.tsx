import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { NO_FILTER, type TodoFilter } from '@/lib/filter-todos';
import { TodoFilterBar } from '../todo-filter-bar';
import type { TodoSummary } from '../types';

const URGENT = { id: 'l1', name: 'urgent', color: '#b91c1c' };

function todo(id: string, fields: Partial<TodoSummary> = {}): TodoSummary {
  return {
    id,
    title: id,
    notes: null,
    dueAt: null,
    completedAt: null,
    position: 0,
    isBlocked: false,
    blockedBy: [],
    dependencies: [],
    labels: [],
    lane: null,
    ...fields,
  };
}

const TODOS = [todo('a', { labels: [URGENT] }), todo('b'), todo('c')];

function bar(filter: Partial<TodoFilter> = {}, matched = TODOS.length, todos = TODOS) {
  const onChange = vi.fn();
  render(<TodoFilterBar filter={{ ...NO_FILTER, ...filter }} onChange={onChange} todos={todos} matched={matched} />);
  return onChange;
}

describe('TodoFilterBar', () => {
  it('reports what was typed without deciding anything itself', async () => {
    const user = userEvent.setup();
    const onChange = bar();

    await user.type(screen.getByLabelText(/filter todos/i), 'a');

    // Controlled: the screen owns the filter, because the board reads it too.
    expect(onChange).toHaveBeenCalledWith({ ...NO_FILTER, text: 'a' });
  });

  it('says nothing about counts until something is actually narrowing', () => {
    bar();
    expect(screen.queryByText(/of 3 todos/)).not.toBeInTheDocument();
  });

  it('counts what survived, so an empty list reads as filtered', () => {
    bar({ text: 'a' }, 1);
    expect(screen.getByText('1 of 3 todos.')).toBeInTheDocument();
  });

  it('says so plainly when nothing matches', () => {
    bar({ text: 'zebra' }, 0);
    // The difference between "this project is empty" and "nothing here matches
    // what you typed" is the whole reason this line exists.
    expect(screen.getByText('No todos match.')).toBeInTheDocument();
  });

  it('treats a sort as not narrowing, so it draws no count', () => {
    bar({ sort: 'due' }, 3);
    expect(screen.queryByText(/of 3 todos/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
  });

  it('toggles the sort and says which way it is', async () => {
    const user = userEvent.setup();
    const onChange = bar();

    const sort = screen.getByRole('button', { name: /manual order/i });
    expect(sort).toHaveAttribute('aria-pressed', 'false');
    await user.click(sort);

    expect(onChange).toHaveBeenCalledWith({ ...NO_FILTER, sort: 'due' });
  });

  it('clears everything at once, and only offers to while there is something to clear', async () => {
    const user = userEvent.setup();
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();

    const onChange = bar({ text: 'a', labelId: URGENT.id, sort: 'due' }, 1);
    await user.click(screen.getByRole('button', { name: 'Clear' }));

    expect(onChange).toHaveBeenCalledWith(NO_FILTER);
  });

  it('offers only the labels this project actually uses', async () => {
    const user = userEvent.setup();
    bar();

    await user.click(screen.getByRole('button', { name: 'Filter by label' }));

    expect(await screen.findByText('urgent')).toBeInTheDocument();
    expect(screen.getByText('Any label')).toBeInTheDocument();
  });

  it('says there are none rather than offering an empty list', async () => {
    const user = userEvent.setup();
    bar({}, 1, [todo('a')]);

    await user.click(screen.getByRole('button', { name: 'Filter by label' }));

    expect(await screen.findByText(/no labels on this project/i)).toBeInTheDocument();
  });

  it('names the chosen label on the trigger', () => {
    bar({ labelId: URGENT.id }, 1);
    expect(screen.getByRole('button', { name: 'Filter by label' })).toHaveTextContent('urgent');
  });
});
