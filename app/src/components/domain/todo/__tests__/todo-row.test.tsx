import { MockedProvider } from '@apollo/client/testing';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { LiveRun } from '@/components/domain/ai/project-activity';
import { AiStateDocument, LabelsDocument } from '@/lib/graphql';
import { TodoRow } from '../todo-row';
import type { TodoSummary } from '../types';

const AI_OFF = {
  request: { query: AiStateDocument },
  result: {
    data: {
      authConfig: { __typename: 'AuthConfig', ai: false, aiAvailable: false },
      users: [{ __typename: 'User', id: 'u1', aiEnabled: false, isAdmin: false }],
    },
  },
};

const TODO: TodoSummary = {
  id: 't1',
  title: 'Replace the tap',
  notes: null,
  acceptance: null,
  aiIgnored: false,
  parentId: null,
  dueAt: null,
  completedAt: null,
  position: 0,
  splitAt: null,
  pieceCount: 0,
  donePieceCount: 0,
  isBlocked: false,
  blockedBy: [],
  dependencies: [],
  labels: [],
  lane: { id: 'l1', name: 'Todo', position: 0, isDone: false },
};

function live(over: Partial<LiveRun> = {}): LiveRun {
  return {
    __typename: 'Run',
    id: 'r1',
    todoId: TODO.id,
    laneId: 'l1',
    cancelRequestedAt: null,
    agent: { __typename: 'Agent', id: 'a1', name: 'Plumber' },
    ...over,
  } as LiveRun;
}

const LABELS = {
  request: { query: LabelsDocument },
  result: { data: { labels: [{ __typename: 'Label', id: 'lb1', name: 'urgent', color: '#b91c1c' }] } },
};

const LANES = [
  { __typename: 'Lane', id: 'l1', name: 'Todo', position: 0, isDone: false },
  { __typename: 'Lane', id: 'l2', name: 'Done', position: 1, isDone: true },
] as never[];

function renderRow(run?: LiveRun, lanes: never[] = []) {
  render(
    <MockedProvider mocks={[AI_OFF, LABELS]}>
      <TodoRow todo={TODO} projectId="p1" siblings={[TODO]} lanes={lanes} live={run} />
    </MockedProvider>,
  );
}

describe('TodoRow', () => {
  it('says which agent is working it, as the board card does', () => {
    renderRow(live());
    expect(screen.getByText('Working · Plumber')).toBeInTheDocument();
  });

  it('says when the agent has been asked to stop', () => {
    renderRow(live({ cancelRequestedAt: '2026-10-15T00:00:00Z' }));
    expect(screen.getByText('Stopping · Plumber')).toBeInTheDocument();
  });

  it('says nothing of an agent when none is working it', () => {
    renderRow();
    expect(screen.queryByText(/^Working/)).not.toBeInTheDocument();
  });

  it('keeps every action behind one menu button', async () => {
    const user = userEvent.setup();
    renderRow(undefined, LANES);
    // One button besides the title and the checkbox, not a row of icons.
    expect(screen.queryByRole('button', { name: 'Labels' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `Archive ${TODO.title}` })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: `Actions for ${TODO.title}` }));
    expect(await screen.findByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Done/ })).toBeInTheDocument();
    expect(await screen.findByRole('menuitemcheckbox', { name: 'urgent' })).toBeInTheDocument();
    expect(screen.getByText('Nothing else in this project yet.')).toBeInTheDocument();
  });
});
