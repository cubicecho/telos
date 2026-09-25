import { MockedProvider } from '@apollo/client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CancelRunDocument, TodoRunsDocument } from '@/lib/graphql';
import { TodoRuns } from '../todo-runs';

function run(id: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    __typename: 'Run',
    id,
    status,
    verdict: 'none',
    contract: 'work',
    output: null,
    error: null,
    toolCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    events: [],
    startedAt: '2026-09-24T10:00:00.000Z',
    finishedAt: status === 'running' ? null : '2026-09-24T10:01:00.000Z',
    cancelRequestedAt: null,
    agent: { __typename: 'Agent', id: 'a1', name: 'Reviewer' },
    lane: { __typename: 'Lane', id: 'l1', name: 'Review' },
    ...extra,
  };
}

function runs(rows: unknown[], artifacts: unknown[] = []) {
  return {
    request: { query: TodoRunsDocument, variables: { id: 't1' } },
    result: {
      data: {
        todo: {
          __typename: 'Todo',
          id: 't1',
          project: { __typename: 'Project', id: 'p1', aiEnabled: true },
          runs: rows,
          artifacts,
        },
      },
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: MockedProvider's mock array type
function show(mocks: any[], pollMs?: number) {
  render(
    <MockedProvider mocks={mocks}>
      <TodoRuns todoId="t1" pollMs={pollMs} />
    </MockedProvider>,
  );
}

describe('TodoRuns', () => {
  it('offers Cancel only on a run that is still running', async () => {
    show([
      runs([run('r2', 'running'), run('r1', 'ok', { totalTokens: 1200, promptTokens: 1000, completionTokens: 200 })]),
    ]);

    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText('Running')).toBeInTheDocument();
    expect(within(items[0]).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(within(items[1]).getByText('Finished')).toBeInTheDocument();
    expect(within(items[1]).queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(within(items[1]).getByText(/took 1m 0s/)).toBeInTheDocument();
    expect(within(items[1]).getByText(/1,200 tokens/)).toBeInTheDocument();
  });

  it('asks again while a run is live, and stops once none is', async () => {
    const third = vi.fn(() => runs([run('r1', 'ok')]).result);
    show(
      [runs([run('r1', 'running')]), runs([run('r1', 'ok', { output: 'All done.' })]), { ...runs([]), result: third }],
      30,
    );

    expect(await screen.findByText('Running')).toBeInTheDocument();
    expect(await screen.findByText('Finished')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();

    // Several poll intervals later, nothing has asked a third time.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(third).not.toHaveBeenCalled();
  });

  it('cancels a running run, and shows the log when opened', async () => {
    const user = userEvent.setup();
    const cancel = vi.fn(() => ({
      data: { cancelRun: run('r1', 'running', { cancelRequestedAt: '2026-09-24T10:00:30.000Z' }) },
    }));
    show([
      runs([
        run('r1', 'running', {
          events: [{ at: '2026-09-24T10:00:05.000Z', kind: 'tool_call', name: 'list_todos', ok: true }],
        }),
      ]),
      { request: { query: CancelRunDocument, variables: { id: 'r1' } }, result: cancel },
    ]);

    await user.click(await screen.findByRole('button', { name: /Review · Reviewer/ }));
    expect(screen.getByRole('log', { name: 'Run log' })).toHaveTextContent('Called list_todos ✓');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(cancel).toHaveBeenCalled());
    expect(await screen.findByText('Stopping…')).toBeInTheDocument();
  });

  it('lists the artifacts', async () => {
    show([
      runs(
        [],
        [
          {
            __typename: 'Artifact',
            id: 'x1',
            location: 'docs/plan.md',
            source: 'declared',
            action: 'created',
            serverSlug: 'files',
            tool: 'write_file',
            title: 'The plan',
            description: null,
            mediaType: 'text/markdown',
            sizeBytes: 120,
            createdAt: '2026-09-24T10:00:30.000Z',
          },
        ],
      ),
    ]);

    expect(await screen.findByText('The plan')).toBeInTheDocument();
    expect(screen.getByText('docs/plan.md · text/markdown')).toBeInTheDocument();
    expect(screen.getByText('created')).toBeInTheDocument();
    expect(screen.getByText('declared')).toBeInTheDocument();
  });
});
