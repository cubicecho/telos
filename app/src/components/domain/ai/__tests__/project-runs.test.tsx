import { MockedProvider } from '@apollo/client/testing';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ProjectRunsDocument } from '@/lib/graphql';
import type { ProjectActivity } from '../project-activity';
import { ProjectRuns, RUNS_PAGE } from '../project-runs';
import { run } from './run-fixtures';

const ACTIVITY: ProjectActivity = {
  live: new Map([
    ['t1', { __typename: 'Run', id: 'r2', todoId: 't1', laneId: 'l1', cancelRequestedAt: null, agent: null }],
  ]),
  spent: {
    __typename: 'RunAggregate',
    count: 12,
    sum: { __typename: 'RunSumAggregate', promptTokens: 30000, completionTokens: 1200, totalTokens: 31200 },
  },
  loading: false,
} as ProjectActivity;

function page(status: string | null, rows: unknown[]) {
  const where = status ? { projectId: { eq: 'p1' }, status: { eq: status } } : { projectId: { eq: 'p1' } };
  return {
    request: { query: ProjectRunsDocument, variables: { where, limit: RUNS_PAGE, offset: 0 } },
    result: { data: { runs: rows } },
  };
}

describe('ProjectRuns', () => {
  it('shows what the project spent, names each run’s todo, and filters by status', async () => {
    const user = userEvent.setup();
    render(
      <MockedProvider
        mocks={[
          page(null, [
            run('r2', 'running'),
            run('r1', 'error', { todo: { __typename: 'Todo', id: 't2', title: 'Fix it' } }),
          ]),
          page('error', [run('r1', 'error', { todo: { __typename: 'Todo', id: 't2', title: 'Fix it' } })]),
        ]}
      >
        <ProjectRuns projectId="p1" activity={ACTIVITY} pollMs={60_000} />
      </MockedProvider>,
    );

    expect(await screen.findByText('31,200')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('30,000 in, 1,200 out, 30 days')).toBeInTheDocument();

    const list = await screen.findByRole('list', { name: 'Runs' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText('Write it — Review · Reviewer')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Failed' }));
    await screen.findByText('Fix it — Review · Reviewer');
    expect(within(screen.getByRole('list', { name: 'Runs' })).getAllByRole('listitem')).toHaveLength(1);
  });
});
