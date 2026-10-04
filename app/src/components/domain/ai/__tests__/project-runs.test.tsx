import { MockedProvider } from '@apollo/client/testing';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ProjectArtifactsDocument, ProjectRunsDocument } from '@/lib/graphql';
import type { ProjectActivity } from '../project-activity';
import { ProjectArtifacts, ProjectRuns, RUNS_PAGE } from '../project-runs';
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

    // One lane run and one reply are under way.
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

/**
 * An artifact as the project's list reads it.
 *
 * @param id Its id.
 * @param fields What differs from a run's declared file.
 * @returns The row.
 */
function artifact(id: string, fields: Record<string, unknown>) {
  return {
    __typename: 'Artifact',
    id,
    todoId: null,
    todoTitle: null,
    location: `/work/${id}.md`,
    source: 'declared',
    action: 'created',
    serverSlug: null,
    tool: null,
    title: null,
    description: null,
    mediaType: null,
    sizeBytes: null,
    createdAt: '2026-09-24T10:00:30.000Z',
    todo: null,
    ...fields,
  };
}

const TODO = {
  __typename: 'Todo',
  id: 't1',
  title: 'Write it',
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
  lane: { __typename: 'Lane', id: 'l1', name: 'To do', position: 0, isDone: false },
};

describe('ProjectArtifacts', () => {
  it('keeps an artifact whose todo was deleted, marked, under the title the todo had', async () => {
    render(
      <MockedProvider
        mocks={[
          {
            request: { query: ProjectArtifactsDocument, variables: { projectId: 'p1', limit: RUNS_PAGE, offset: 0 } },
            result: {
              data: {
                artifacts: [
                  artifact('kept', { todoId: 't1', todo: TODO }),
                  artifact('orphan', { todoTitle: 'Draft the plan' }),
                  artifact('nameless', { source: 'client', title: 'A page', location: 'https://example.com/page' }),
                ],
              },
            },
          },
        ]}
      >
        <ProjectArtifacts projectId="p1" />
      </MockedProvider>,
    );

    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText('Write it')).toBeInTheDocument();
    expect(within(rows[0]).queryByText(/todo deleted/i)).not.toBeInTheDocument();
    expect(within(rows[1]).getByText('Draft the plan (todo deleted)')).toBeInTheDocument();
    expect(within(rows[2]).getByText('Todo deleted · https://example.com/page')).toBeInTheDocument();
    expect(within(rows[2]).getByText('unverified')).toBeInTheDocument();
    // Still the owner's to take off the board.
    expect(within(rows[1]).getByRole('button', { name: 'Remove /work/orphan.md from the board' })).toBeInTheDocument();
  });

  it('says so when nothing has been made', async () => {
    render(
      <MockedProvider
        mocks={[
          {
            request: { query: ProjectArtifactsDocument, variables: { projectId: 'p1', limit: RUNS_PAGE, offset: 0 } },
            result: { data: { artifacts: [] } },
          },
        ]}
      >
        <ProjectArtifacts projectId="p1" />
      </MockedProvider>,
    );
    expect(await screen.findByText('Nothing has been made for this project’s todos yet.')).toBeInTheDocument();
  });
});
