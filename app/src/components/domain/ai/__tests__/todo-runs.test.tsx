import { MockedProvider } from '@apollo/client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CancelRunDocument, DeleteRunDocument, TodoRunsDocument } from '@/lib/graphql';
import { TodoRuns } from '../todo-runs';
import { fullRun, run, runMock } from './run-fixtures';

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
      runs([run('r1', 'running')]),
      runMock(
        fullRun('r1', 'running', {
          events: [{ at: '2026-09-24T10:00:05.000Z', kind: 'tool_call', name: 'list_todos', text: '{}' }],
        }),
      ),
      { request: { query: CancelRunDocument, variables: { id: 'r1' } }, result: cancel },
    ]);

    await user.click(await screen.findByRole('button', { name: /^Review · Reviewer/ }));
    expect(await screen.findByRole('log', { name: 'Run log' })).toHaveTextContent('→ list_todos({})');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(cancel).toHaveBeenCalled());
    expect(await screen.findByText('Stopping…')).toBeInTheDocument();
  });

  it('draws the log the way it happened, and the prompts behind a disclosure', async () => {
    const user = userEvent.setup();
    show([
      runs([run('r1', 'ok', { totalTokens: 10 })]),
      runMock(
        fullRun('r1', 'ok', {
          output: 'Shipped.',
          systemPrompt: 'You are a reviewer.',
          userPrompt: 'Review “Write it”.',
          events: [
            { kind: 'turn', text: 'Turn 1' },
            { kind: 'thinking', text: 'Look at the diff first.' },
            { kind: 'tool_call', name: 'read_file', text: '{"path":"a.ts"}' },
            { kind: 'tool_result', name: 'read_file', ok: false, text: 'ENOENT' },
            { kind: 'output', text: 'Shipped.' },
          ],
        }),
      ),
    ]);

    await user.click(await screen.findByRole('button', { name: /^Review · Reviewer/ }));
    const log = await screen.findByRole('log', { name: 'Run log' });
    expect(within(log).getByText('Turn 1')).toBeInTheDocument();
    expect(within(log).getByText('Look at the diff first.')).toBeInTheDocument();
    expect(log).toHaveTextContent('→ read_file({"path":"a.ts"})');
    expect(log).toHaveTextContent('← read_file failed: ENOENT');
    // The output streamed into the log, so it is not drawn twice.
    expect(screen.getAllByText('Shipped.')).toHaveLength(1);

    expect(screen.queryByText('You are a reviewer.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /What it was told/ }));
    expect(screen.getByText('You are a reviewer.')).toBeInTheDocument();
    expect(screen.getByText('Model qwen3')).toBeInTheDocument();
  });

  it('deletes a finished run once confirmed, and offers no delete on a live one', async () => {
    const user = userEvent.setup();
    const remove = vi.fn(() => ({ data: { deleteRun: true } }));
    show([
      runs([run('r2', 'running'), run('r1', 'error', { error: 'Timed out' })]),
      { request: { query: DeleteRunDocument, variables: { id: 'r1' } }, result: remove },
    ]);

    const items = await screen.findAllByRole('listitem');
    expect(within(items[0]).queryByRole('button', { name: /Delete the run/ })).not.toBeInTheDocument();
    await user.click(within(items[1]).getByRole('button', { name: /Delete the run/ }));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(remove).toHaveBeenCalled());
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
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
