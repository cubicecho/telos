import { MockedProvider } from '@apollo/client/testing';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AiStateDocument, SearchTodosDocument } from '@/lib/graphql';
import { TodoSearch, useSearchShortcut } from '../todo-search';

const push = vi.fn();
vi.mock('expo-router', () => ({ useRouter: () => ({ push }) }));

function found(id: string, title: string) {
  return {
    __typename: 'Todo' as const,
    id,
    title,
    notes: null,
    acceptance: null,
    aiIgnored: false,
    parentId: null,
    dueAt: null,
    completedAt: null,
    position: 0,
    isBlocked: false,
    blockedBy: [],
    dependencies: [],
    labels: [],
    lane: { __typename: 'Lane' as const, id: 'l1', name: 'To do', position: 0, isDone: false },
    project: { __typename: 'Project' as const, id: 'p1', name: 'Kitchen' },
  };
}

const SEARCH = {
  request: { query: SearchTodosDocument, variables: { text: 'tile' } },
  result: { data: { todos: [found('t1', 'Buy tiles'), found('t2', 'Grout the tile')] } },
};

const AI_OFF = {
  request: { query: AiStateDocument },
  result: {
    data: {
      authConfig: { __typename: 'AuthConfig', ai: false, aiAvailable: false },
      users: [{ __typename: 'User', id: 'u1', aiEnabled: false, isAdmin: false }],
    },
  },
};

function Harness() {
  const [open, setOpen] = useState(false);
  useSearchShortcut(() => setOpen(true));
  return <TodoSearch open={open} onOpenChange={setOpen} />;
}

describe('TodoSearch', () => {
  it('opens on Ctrl+K, finds todos, and goes to the one picked', async () => {
    const user = userEvent.setup();
    render(
      <MockedProvider mocks={[SEARCH, AI_OFF]}>
        <Harness />
      </MockedProvider>,
    );

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const field = await screen.findByLabelText('Search todos');
    await user.type(field, 'tile');
    expect(await screen.findByText('Grout the tile')).toBeInTheDocument();
    expect(screen.getAllByText('Kitchen · To do')).toHaveLength(2);

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: /Grout the tile/ })).toHaveAttribute('aria-selected', 'true');
    await user.type(field, '{Enter}');
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/projects/p1'));
    expect(screen.queryByLabelText('Search todos')).not.toBeInTheDocument();
    // And the todo itself opens.
    expect(await screen.findByDisplayValue('Grout the tile')).toBeInTheDocument();
  });

  it('says when nothing matches', async () => {
    const user = userEvent.setup();
    render(
      <MockedProvider
        mocks={[
          { request: { query: SearchTodosDocument, variables: { text: 'zebra' } }, result: { data: { todos: [] } } },
        ]}
      >
        <TodoSearch open onOpenChange={() => {}} />
      </MockedProvider>,
    );
    await user.type(await screen.findByLabelText('Search todos'), 'zebra');
    expect(await screen.findByText('Nothing matches “zebra”.')).toBeInTheDocument();
  });
});
