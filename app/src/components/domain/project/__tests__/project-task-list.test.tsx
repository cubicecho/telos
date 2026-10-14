import { MockedProvider } from '@apollo/client/testing';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  AiStateDocument,
  CreateTodoDocument,
  LabelsDocument,
  ProjectLanesDocument,
  ProjectTodosDocument,
} from '@/lib/graphql';
import { ProjectTaskList } from '../project-task-list';

vi.mock('@/lib/ids', () => ({ newId: () => 'new1' }));
vi.mock('expo-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
}));

const LANE = { __typename: 'Lane' as const, id: 'l1', name: 'Todo', position: 0, isDone: false };
const DONE_LANE = { __typename: 'Lane' as const, id: 'l2', name: 'Done', position: 1, isDone: true };

function todo(id: string, title: string, position: number, completedAt: string | null = null) {
  return {
    __typename: 'Todo' as const,
    id,
    title,
    notes: null,
    acceptance: null,
    aiIgnored: false,
    parentId: null,
    dueAt: null,
    completedAt,
    position,
    isBlocked: false,
    blockedBy: [],
    dependencies: [],
    labels: [],
    lane: completedAt ? DONE_LANE : LANE,
  };
}

const AI_OFF = {
  request: { query: AiStateDocument },
  result: {
    data: {
      authConfig: { __typename: 'AuthConfig', ai: false, aiAvailable: false },
      users: [{ __typename: 'User', id: 'u1', aiEnabled: false, isAdmin: false }],
    },
  },
  maxUsageCount: Number.POSITIVE_INFINITY,
};

const LABELS = {
  request: { query: LabelsDocument },
  result: { data: { labels: [] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
};

const LANES = {
  request: { query: ProjectLanesDocument, variables: { projectId: 'p1' } },
  result: { data: { lanes: [LANE, DONE_LANE] } },
};

function todos(rows: ReturnType<typeof todo>[]) {
  return {
    request: { query: ProjectTodosDocument, variables: { projectId: 'p1' } },
    result: { data: { todos: rows } },
  };
}

const PROJECT = { id: 'p1', name: 'Garden' };

describe('a project on the overview', () => {
  it('lists what is open and folds what is done away', async () => {
    render(
      <MockedProvider
        mocks={[
          AI_OFF,
          LABELS,
          LANES,
          todos([todo('t1', 'Water it', 0), todo('t2', 'Plant it', 1, '2026-10-01T00:00:00.000Z')]),
        ]}
      >
        <ProjectTaskList project={PROJECT} />
      </MockedProvider>,
    );

    expect(await screen.findByText('Water it')).toBeTruthy();
    expect(screen.getByText('Garden')).toBeTruthy();
    expect(screen.queryByText('Plant it')).toBeNull();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Show completed (1)' }));
    expect(screen.getByText('Plant it')).toBeTruthy();
  });

  it('says so when the project has nothing in it', async () => {
    render(
      <MockedProvider mocks={[AI_OFF, LABELS, LANES, todos([])]}>
        <ProjectTaskList project={PROJECT} />
      </MockedProvider>,
    );
    expect(await screen.findByText('No todos yet.')).toBeTruthy();
  });

  it('adds a todo at the end of the project', async () => {
    const values = { id: 'new1', projectId: 'p1', title: 'Weed it', position: 1 };
    const result = vi.fn(() => ({ data: { createTodo: { ...todo('new1', 'Weed it', 1) } } }));
    render(
      <MockedProvider
        mocks={[
          AI_OFF,
          LABELS,
          LANES,
          todos([todo('t1', 'Water it', 0)]),
          { request: { query: CreateTodoDocument, variables: { values } }, result },
        ]}
      >
        <ProjectTaskList project={PROJECT} />
      </MockedProvider>,
    );

    await screen.findByText('Water it');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'New todo in Garden' }));
    await user.type(screen.getByRole('textbox', { name: 'New todo in Garden' }), 'Weed it{Enter}');

    await waitFor(() => expect(result).toHaveBeenCalled());
  });
});
