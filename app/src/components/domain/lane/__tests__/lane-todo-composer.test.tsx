import { MockedProvider } from '@apollo/client/testing';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TodoSummary } from '@/components/domain/todo/types';
import { AiStateDocument, CardMarksDocument, CreateTodoDocument } from '@/lib/graphql';
import { Board } from '../board';

vi.mock('@/lib/ids', () => ({ newId: () => 'new1' }));

const LANES = [
  { __typename: 'Lane' as const, id: 'l1', name: 'Todo', position: 0, isDone: false },
  { __typename: 'Lane' as const, id: 'l2', name: 'Done', position: 1, isDone: true },
];

const AI_OFF = {
  request: { query: AiStateDocument },
  result: {
    data: {
      authConfig: { __typename: 'AuthConfig', ai: false, aiAvailable: false },
      users: [{ __typename: 'User', id: 'u1', aiEnabled: false, isAdmin: false }],
    },
  },
};

const NO_MARKS = {
  request: { query: CardMarksDocument, variables: { projectId: 'p1' } },
  result: { data: { cardMarks: [] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
};

const CARD: TodoSummary = {
  id: 't1',
  title: 'Write it',
  notes: null,
  acceptance: null,
  aiIgnored: false,
  parentId: null,
  dueAt: null,
  completedAt: null,
  position: 4,
  isBlocked: false,
  blockedBy: [],
  dependencies: [],
  labels: [],
  lane: { id: 'l1', name: 'Todo', position: 0, isDone: false },
};

function created(values: Record<string, unknown>) {
  return vi.fn(() => ({
    data: {
      createTodo: {
        __typename: 'Todo',
        id: 'new1',
        title: values.title,
        notes: null,
        acceptance: null,
        aiIgnored: false,
        parentId: null,
        dueAt: null,
        completedAt: values.completedAt ?? null,
        position: values.position,
        isBlocked: false,
        blockedBy: [],
        dependencies: [],
        labels: [],
        lane: LANES[1],
      },
    },
  }));
}

describe('adding a todo to an empty lane', () => {
  it('offers the button only in lanes with nothing in them', () => {
    render(
      <MockedProvider mocks={[AI_OFF, NO_MARKS]}>
        <Board projectId="p1" lanes={LANES} todos={[CARD]} nextPosition={5} />
      </MockedProvider>,
    );
    expect(screen.queryByRole('button', { name: 'New todo in Todo' })).toBeNull();
    expect(screen.getByRole('button', { name: 'New todo in Done' })).toBeTruthy();
  });

  it('creates the todo in that lane, done when the lane means done', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T12:00:00.000Z'));
    const values = {
      id: 'new1',
      projectId: 'p1',
      title: 'Ship it',
      position: 5,
      laneId: 'l2',
      completedAt: '2026-10-14T12:00:00.000Z',
    };
    const result = created(values);
    render(
      <MockedProvider
        mocks={[AI_OFF, NO_MARKS, { request: { query: CreateTodoDocument, variables: { values } }, result }]}
      >
        <Board projectId="p1" lanes={LANES} todos={[CARD]} nextPosition={5} />
      </MockedProvider>,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'New todo in Done' }));
    await user.type(screen.getByRole('textbox', { name: 'New todo in Done' }), 'Ship it{Enter}');

    await waitFor(() => expect(result).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'New todo in Done' })).toBeTruthy();
    vi.useRealTimers();
  });
});
