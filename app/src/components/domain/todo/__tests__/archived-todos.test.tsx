import { MockedProvider } from '@apollo/client/testing';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ArchivedTodosDocument, DeleteTodoForGoodDocument, RestoreTodoDocument } from '@/lib/graphql';
import { ArchivedTodos } from '../archived-todos';

const ARCHIVED = {
  request: { query: ArchivedTodosDocument, variables: { projectId: 'p1' } },
  result: {
    data: {
      todos: [
        {
          __typename: 'Todo',
          id: 't1',
          title: 'Old idea',
          completedAt: null,
          archivedAt: '2026-09-25T08:00:00.000Z',
          lane: { __typename: 'Lane', id: 'l1', name: 'Todo' },
        },
      ],
    },
  },
};

describe('ArchivedTodos', () => {
  it('restores an archived todo', async () => {
    const user = userEvent.setup();
    const restored = vi.fn(() => ({ data: { restoreTodo: { __typename: 'Todo', id: 't1' } } }));
    render(
      <MockedProvider
        mocks={[ARCHIVED, { request: { query: RestoreTodoDocument, variables: { id: 't1' } }, result: restored }]}
      >
        <ArchivedTodos projectId="p1" />
      </MockedProvider>,
    );
    const list = await screen.findByRole('list', { name: 'Archived todos' });
    expect(within(list).getByText('Old idea')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Restore Old idea' }));
    await vi.waitFor(() => expect(restored).toHaveBeenCalled());
  });

  it('deletes one for good only once asked twice', async () => {
    const user = userEvent.setup();
    const deleted = vi.fn(() => ({ data: { deleteTodo: { __typename: 'Todo', id: 't1' } } }));
    render(
      <MockedProvider
        mocks={[ARCHIVED, { request: { query: DeleteTodoForGoodDocument, variables: { id: 't1' } }, result: deleted }]}
      >
        <ArchivedTodos projectId="p1" />
      </MockedProvider>,
    );
    await user.click(await screen.findByRole('button', { name: 'Delete Old idea for good' }));
    expect(deleted).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await vi.waitFor(() => expect(deleted).toHaveBeenCalled());
  });

  it('says when nothing is archived', async () => {
    render(
      <MockedProvider mocks={[{ ...ARCHIVED, result: { data: { todos: [] } } }]}>
        <ArchivedTodos projectId="p1" />
      </MockedProvider>,
    );
    expect(await screen.findByText('Nothing archived.')).toBeInTheDocument();
  });
});
