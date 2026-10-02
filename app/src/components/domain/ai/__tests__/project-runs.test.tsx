import { MockedProvider } from '@apollo/client/testing';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ProjectRunsDocument } from '@/lib/graphql';
import type { ProjectActivity } from '../project-activity';
import { ProjectRuns, RUNS_PAGE } from '../project-runs';
import { draftRun, run } from './run-fixtures';

const ACTIVITY: ProjectActivity = {
  live: new Map([
    [
      't1',
      { __typename: 'Run', id: 'r2', kind: 'todo', todoId: 't1', laneId: 'l1', cancelRequestedAt: null, agent: null },
    ],
  ]),
  drafting: [],
  draftSpent: { __typename: 'RunAggregate', count: 0, sum: null },
  stuck: new Map(),
  waiting: new Map(),
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

  it('lists a draft’s replies among the runs, marked as drafts, and says what they cost', async () => {
    const drafting = {
      __typename: 'Run',
      id: 'r3',
      kind: 'draft',
      todoId: null,
      laneId: null,
      cancelRequestedAt: null,
      agent: null,
    };
    const activity = {
      ...ACTIVITY,
      drafting: [drafting],
      draftSpent: { __typename: 'RunAggregate', count: 4, sum: { __typename: 'RunSumAggregate', totalTokens: 900 } },
    } as ProjectActivity;
    render(
      <MockedProvider mocks={[page(null, [draftRun('r3', 'running'), run('r2', 'running')])]}>
        <ProjectRuns projectId="p1" activity={activity} pollMs={60_000} />
      </MockedProvider>,
    );

    // One station run and one reply are under way.
    expect(await screen.findByRole('button', { name: /Running now.*2.*1 draft reply/ })).toBeInTheDocument();
    expect(screen.getByText('in 30 days, 4 draft replies')).toBeInTheDocument();
    expect(screen.getByText('30,000 in, 1,200 out, 900 on drafts, 30 days')).toBeInTheDocument();

    const [reply, work] = within(await screen.findByRole('list', { name: 'Runs' })).getAllByRole('listitem');
    expect(within(reply).getByText('Faster export — Draft reply · Planner')).toBeInTheDocument();
    expect(within(reply).getByText('Draft')).toBeInTheDocument();
    expect(within(work).getByText('Write it — Review · Reviewer')).toBeInTheDocument();
    expect(within(work).queryByText('Draft')).not.toBeInTheDocument();
  });
});
