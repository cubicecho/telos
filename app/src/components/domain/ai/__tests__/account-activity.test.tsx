import { MockedProvider, type MockedResponse } from '@apollo/client/testing';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GraphQLError } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import {
  AccountArchivedTodosDocument,
  AccountArtifactsDocument,
  AccountAttentionDocument,
  AccountRunsDocument,
  AccountSpendDocument,
  RestoreTodoDocument,
  RetryTodoDocument,
} from '@/lib/graphql';
import ActivityScreen from '../../../../../app/(app)/activity';
import { AccountActivity, type AccountView } from '../account-activity';
import { RUNS_PAGE } from '../project-runs';
import { aiStateMock, draftRun, run } from './run-fixtures';

const params = vi.hoisted(() => ({ view: undefined as string | undefined }));

vi.mock('expo-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  Redirect: ({ href }: { href: string }) => `Redirected to ${href}`,
  router: { setParams: vi.fn() },
  useLocalSearchParams: () => params,
}));

const SITE = { __typename: 'Project', id: 'p1', name: 'Site' };
const DOCS = { __typename: 'Project', id: 'p2', name: 'Docs' };

function line(id: string | null, name: string, runs: number, totalTokens: number, extra: Record<string, unknown> = {}) {
  return {
    __typename: 'SpendLine',
    id,
    name,
    runs,
    draftReplies: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens,
    ...extra,
  };
}

function spend(extra: Record<string, unknown> = {}): MockedResponse {
  return {
    request: { query: AccountSpendDocument },
    // The window's start is the clock's, rounded to the hour.
    variableMatcher: () => true,
    result: {
      data: {
        accountSpend: {
          __typename: 'AccountSpend',
          since: '2026-09-02T10:00:00.000Z',
          keptSince: null,
          retentionDays: null,
          total: line(null, 'Every project', 14, 41_200, {
            draftReplies: 2,
            promptTokens: 40_000,
            completionTokens: 1200,
          }),
          byProject: [line('p1', 'Site', 10, 40_000, { draftReplies: 2 }), line('p2', 'Docs', 4, 1200)],
          byAgent: [line('a1', 'Reviewer', 13, 41_000, { draftReplies: 2 }), line(null, 'A deleted agent', 1, 200)],
          ...extra,
        },
      },
    },
  };
}

function stuck(todoId: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    __typename: 'AttentionTodo',
    todoId,
    title,
    projectId: 'p1',
    projectName: 'Site',
    laneId: 'l1',
    laneName: 'Doing',
    outOfAttempts: false,
    errored: true,
    reason: 'The model did not answer.',
    runId: 'r1',
    attempts: 1,
    maxAttempts: 3,
    ...extra,
  };
}

function attention(rows: unknown[]): MockedResponse {
  return { request: { query: AccountAttentionDocument }, result: { data: { accountAttention: rows } } };
}

function runs(status: string | null, rows: unknown[]): MockedResponse {
  const where = status ? { status: { eq: status } } : {};
  return {
    request: { query: AccountRunsDocument, variables: { where, limit: RUNS_PAGE, offset: 0 } },
    result: { data: { runs: rows } },
  };
}

const NO_RUNS = runs(null, []);

function show(mocks: MockedResponse[], view: AccountView = 'runs', onViewChange = vi.fn()) {
  return render(
    <MockedProvider mocks={mocks}>
      <AccountActivity view={view} onViewChange={onViewChange} pollMs={600_000} runsPollMs={600_000} />
    </MockedProvider>,
  );
}

describe('AccountActivity', () => {
  it('lists the todos that need a person, with their project, and sends one round again', async () => {
    const user = userEvent.setup();
    const retried = vi.fn(() => ({ data: { retryTodo: true } }));
    show([
      attention([
        stuck('t1', 'Flaky'),
        stuck('t2', 'Sent back', {
          projectName: 'Docs',
          outOfAttempts: true,
          errored: false,
          reason: 'FAIL: the second paragraph is missing.',
          attempts: 2,
          maxAttempts: 1,
        }),
      ]),
      { request: { query: RetryTodoDocument, variables: { id: 't1' } }, result: retried },
      attention([]),
      spend(),
      NO_RUNS,
    ]);

    const list = await screen.findByRole('list', { name: 'Needs attention' });
    const [flaky, sentBack] = within(list).getAllByRole('listitem');
    expect(within(flaky).getByText('Errored')).toBeInTheDocument();
    expect(within(flaky).getByText('Site · Doing · 1 of 3 attempts')).toBeInTheDocument();
    expect(within(flaky).getByText('The model did not answer.')).toBeInTheDocument();
    expect(within(sentBack).getByText('Out of attempts')).toBeInTheDocument();
    expect(within(sentBack).queryByText('Errored')).not.toBeInTheDocument();
    expect(within(sentBack).getByText('Docs · Doing · 2 of 1 attempt')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Send “Flaky” round again' }));
    await vi.waitFor(() => expect(retried).toHaveBeenCalled());
    expect(await screen.findByText('Nothing is waiting on you.')).toBeInTheDocument();
  });

  it('says why a retry did not happen', async () => {
    const user = userEvent.setup();
    show([
      attention([stuck('t1', 'Flaky')]),
      {
        request: { query: RetryTodoDocument, variables: { id: 't1' } },
        result: { errors: [new GraphQLError('An agent is working it now.')] },
      },
      spend(),
      NO_RUNS,
    ]);
    await user.click(await screen.findByRole('button', { name: 'Send “Flaky” round again' }));
    expect(await screen.findByText(/An agent is working it now\./)).toBeInTheDocument();
  });

  it('shows what was spent, by project and by agent, drafts among it', async () => {
    show([attention([]), spend(), NO_RUNS]);

    expect(await screen.findByText('41,200')).toBeInTheDocument();
    expect(screen.getByText('in 30 days, 2 draft replies')).toBeInTheDocument();
    expect(screen.getByText('40,000 in, 1,200 out')).toBeInTheDocument();
    expect(screen.getByText('A draft reply’s tokens are an estimate.')).toBeInTheDocument();
    expect(screen.queryByText(/Runs are kept for/)).not.toBeInTheDocument();

    const [site, docs] = within(screen.getByRole('list', { name: 'By project' })).getAllByRole('listitem');
    expect(within(site).getByText('Site')).toBeInTheDocument();
    expect(within(site).getByText('10 runs, 2 draft replies')).toBeInTheDocument();
    expect(within(site).getByText('40,000 tokens')).toBeInTheDocument();
    expect(within(docs).getByText('4 runs')).toBeInTheDocument();

    const [reviewer, deleted] = within(screen.getByRole('list', { name: 'By agent' })).getAllByRole('listitem');
    expect(within(reviewer).getByText('41,000 tokens')).toBeInTheDocument();
    expect(within(deleted).getByText('A deleted agent')).toBeInTheDocument();
    expect(within(deleted).getByText('1 run')).toBeInTheDocument();
  });

  it('says where the figures start once retention has trimmed the window', async () => {
    show([attention([]), spend({ keptSince: '2026-09-25T10:00:00.000Z', retentionDays: 7 }), NO_RUNS]);
    expect(
      await screen.findByText(/Runs are kept for 7 days, so these figures start on .+, not 30 days back\./),
    ).toBeInTheDocument();
  });

  it('lists every project’s runs with the project named, a draft’s reply marked, and filters by status', async () => {
    const user = userEvent.setup();
    const failed = run('r1', 'error', { todo: { __typename: 'Todo', id: 't2', title: 'Fix it' }, project: DOCS });
    show([
      attention([]),
      spend(),
      runs(null, [draftRun('r3', 'ok', { project: SITE }), run('r2', 'running', { project: SITE }), failed]),
      runs('error', [failed]),
    ]);

    const [reply, work, fix] = within(await screen.findByRole('list', { name: 'Runs' })).getAllByRole('listitem');
    expect(within(reply).getByText('Faster export — Draft reply · Planner')).toBeInTheDocument();
    expect(within(reply).getByText('Draft')).toBeInTheDocument();
    expect(within(reply).getByText(/^Site · /)).toBeInTheDocument();
    expect(within(work).getByText('Write it — Review · Reviewer')).toBeInTheDocument();
    expect(within(work).queryByText('Draft')).not.toBeInTheDocument();
    expect(within(fix).getByText(/^Docs · /)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Failed' }));
    await vi.waitFor(() =>
      expect(within(screen.getByRole('list', { name: 'Runs' })).getAllByRole('listitem')).toHaveLength(1),
    );
    expect(screen.getByText('Fix it — Review · Reviewer')).toBeInTheDocument();
  });

  it('lists artifacts with where each came from, and draws one whose todo is gone', async () => {
    const artifact = {
      __typename: 'Artifact',
      id: 'x1',
      todoId: null,
      todoTitle: 'Plan the site',
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
      project: SITE,
      todo: null,
    };
    show(
      [
        attention([]),
        spend(),
        {
          request: { query: AccountArtifactsDocument, variables: { limit: RUNS_PAGE, offset: 0 } },
          result: { data: { artifacts: [artifact] } },
        },
      ],
      'artifacts',
    );

    const list = await screen.findByRole('list', { name: 'Artifacts' });
    expect(within(list).getByText('The plan')).toBeInTheDocument();
    expect(
      within(list).getByText('Site · Plan the site (todo deleted) · docs/plan.md · text/markdown'),
    ).toBeInTheDocument();
    // Only the view that is showing asks for its rows.
    expect(screen.queryByRole('list', { name: 'Runs' })).not.toBeInTheDocument();
  });

  it('lists archived todos across projects and restores one', async () => {
    const user = userEvent.setup();
    const restored = vi.fn(() => ({ data: { restoreTodo: { __typename: 'Todo', id: 't1' } } }));
    const archived = (rows: unknown[]): MockedResponse => ({
      request: { query: AccountArchivedTodosDocument, variables: { limit: RUNS_PAGE, offset: 0 } },
      result: { data: { todos: rows } },
    });
    show(
      [
        attention([]),
        spend(),
        archived([
          {
            __typename: 'Todo',
            id: 't1',
            title: 'Old idea',
            completedAt: null,
            archivedAt: '2026-09-25T08:00:00.000Z',
            lane: { __typename: 'Lane', id: 'l1', name: 'Todo' },
            project: DOCS,
          },
        ]),
        { request: { query: RestoreTodoDocument, variables: { id: 't1' } }, result: restored },
        archived([]),
      ],
      'archived',
    );

    const list = await screen.findByRole('list', { name: 'Archived todos' });
    expect(within(list).getByText('Old idea')).toBeInTheDocument();
    expect(within(list).getByText(/^Docs · Archived .+ · Todo$/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Restore Old idea' }));
    await vi.waitFor(() => expect(restored).toHaveBeenCalled());
    expect(await screen.findByText('Nothing archived.')).toBeInTheDocument();
  });

  it('asks for another view through its caller', async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    show([attention([]), spend(), NO_RUNS], 'runs', onViewChange);
    await user.click(await screen.findByRole('tab', { name: 'Artifacts' }));
    expect(onViewChange).toHaveBeenCalledWith('artifacts');
  });
});

describe('the activity page', () => {
  it('draws the account’s activity while AI is on', async () => {
    render(
      <MockedProvider mocks={[aiStateMock(true, true), attention([]), spend(), NO_RUNS]}>
        <ActivityScreen />
      </MockedProvider>,
    );
    expect(await screen.findByText('Nothing is waiting on you.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeInTheDocument();
  });

  it.each([
    ['the account', true, false],
    ['the instance', false, false],
  ])('is not there while AI is off for %s: a link to it goes home', async (_whose, instance, account) => {
    render(
      <MockedProvider mocks={[aiStateMock(instance, account)]}>
        <ActivityScreen />
      </MockedProvider>,
    );
    expect(await screen.findByText('Redirected to /')).toBeInTheDocument();
    expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();
  });
});
