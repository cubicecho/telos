import { MockedProvider } from '@apollo/client/testing';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AiStatusDocument, RecentFailuresDocument, RetryTodoDocument } from '@/lib/graphql';
import { AiStatus } from '../ai-status';
import { run } from './run-fixtures';

vi.mock('expo-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
}));

function todo(todoId: string, title: string, state: string, extra: Record<string, unknown> = {}) {
  return {
    __typename: 'StationTodo',
    todoId,
    title,
    projectId: 'p1',
    laneId: 'l1',
    state,
    reason: null,
    failures: 0,
    liveRunId: null,
    ...extra,
  };
}

function lane(laneId: string, name: string, counts: Record<string, number>, station = true) {
  return {
    __typename: 'LaneTally',
    laneId,
    name,
    station,
    isDone: false,
    attention: 0,
    running: 0,
    blocked: 0,
    queued: 0,
    parked: 0,
    done: 0,
    ...counts,
  };
}

const STATUS = {
  request: { query: AiStatusDocument },
  result: {
    data: {
      aiStatus: {
        __typename: 'AiStatus',
        todos: [
          todo('t1', 'Flaky', 'attention', { reason: 'It broke.', failures: 4 }),
          todo('t2', 'Busy', 'running', { liveRunId: 'r9' }),
          todo('t3', 'Next', 'queued'),
        ],
        projects: [
          {
            __typename: 'ProjectTally',
            projectId: 'p1',
            name: 'Site',
            lanes: [
              lane('l1', 'Doing', { attention: 1, running: 1, queued: 1 }),
              lane('l2', 'Done', { done: 5 }, false),
            ],
          },
        ],
        runnerSeenAt: null,
      },
    },
  },
};

function failures() {
  const hour = 60 * 60 * 1000;
  const since = new Date(Math.floor((Date.now() - 24 * hour) / hour) * hour).toISOString();
  return {
    request: { query: RecentFailuresDocument, variables: { since } },
    result: {
      data: {
        runs: [
          {
            ...run('r1', 'error', { error: 'Out of tokens' }),
            project: { __typename: 'Project', id: 'p1', name: 'Site' },
          },
        ],
      },
    },
  };
}

describe('AiStatus', () => {
  it('leads with what needs you, counts every state and lane, and lists what failed', async () => {
    const user = userEvent.setup();
    const retried = vi.fn(() => ({ data: { retryTodo: true } }));
    render(
      <MockedProvider
        mocks={[
          STATUS,
          failures(),
          { request: { query: RetryTodoDocument, variables: { id: 't1' } }, result: retried },
          STATUS,
        ]}
      >
        <AiStatus pollMs={60_000} />
      </MockedProvider>,
    );

    const needs = await screen.findByRole('list', { name: 'Needs you' });
    expect(within(needs).getByText('Flaky')).toBeInTheDocument();
    expect(within(needs).getByText('It broke.')).toBeInTheDocument();
    expect(within(needs).getByText('Site · Doing · 4 failed attempts')).toBeInTheDocument();
    expect(screen.getByText(/The runner has not asked for work/)).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();

    const lanes = screen.getByRole('list', { name: 'Site’s lanes' });
    expect(within(lanes).getByText('resting place')).toBeInTheDocument();
    expect(await screen.findByText('Write it — Review · Reviewer')).toBeInTheDocument();

    await user.click(within(needs).getByRole('button', { name: 'Send “Flaky” round again' }));
    await vi.waitFor(() => expect(retried).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: /Running/ }));
    const running = await screen.findByRole('list', { name: 'Running' });
    expect(within(running).getByRole('button', { name: 'Watch the agent work “Busy”' })).toBeInTheDocument();
  });
});
