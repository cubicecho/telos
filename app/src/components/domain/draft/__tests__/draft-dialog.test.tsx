import { MockedProvider } from '@apollo/client/testing';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentsDocument,
  DraftDocument,
  MakeTodoFromDraftDocument,
  OpenDraftsDocument,
  StartDraftDocument,
} from '@/lib/graphql';
import { draftRun, fullRun, runMock } from '../../ai/__tests__/run-fixtures';
import { DraftDialog } from '../draft-dialog';

const AGENT = {
  __typename: 'Agent',
  id: 'a1',
  name: 'Planner',
  baseUrl: 'http://localhost:11434/v1',
  model: 'qwen3:14b',
  systemPrompt: null,
  temperature: null,
  maxTokens: null,
  contextLength: null,
  maxToolIterations: 20,
  toolDiscovery: false,
  toolSelectModel: null,
  requestTimeoutSeconds: null,
  maxRetries: null,
  mcpServers: [],
  hasApiKey: false,
};

const FIELDS = {
  __typename: 'Draft',
  id: 'd1',
  projectId: 'p1',
  agentId: 'a1',
  error: null,
  todoId: null,
  updatedAt: '2026-09-25T10:00:00.000Z',
};

const ASKED = { __typename: 'DraftMessage', id: 'm1', role: 'user', content: 'Export is slow' };

const WAITING = { ...FIELDS, title: '', brief: '', waitingSince: '2026-09-25T10:00:00.000Z' };

const ANSWERED = {
  ...FIELDS,
  title: 'Faster export',
  brief: 'Speed up the CSV export.',
  waitingSince: null,
  agent: { __typename: 'Agent', id: 'a1', name: 'Planner' },
  messages: [ASKED, { __typename: 'DraftMessage', id: 'm2', role: 'assistant', content: 'How big are the files?' }],
  runs: [draftRun('r1', 'ok')],
};

const FAILED_REPLY = draftRun('r2', 'error', { error: 'The model timed out.' });

const FAILED = {
  ...FIELDS,
  title: '',
  brief: '',
  waitingSince: null,
  error: 'The model timed out.',
};

const openDrafts = {
  request: { query: OpenDraftsDocument, variables: { projectId: 'p1' } },
  result: { data: { drafts: [] } },
};
const draft = (value: unknown) => ({
  request: { query: DraftDocument, variables: { id: 'd1' } },
  result: { data: { draft: value } },
});

describe('DraftDialog', () => {
  it('starts a draft, shows the agent’s answer, and makes a todo from the edited brief', async () => {
    const user = userEvent.setup();
    const make = vi.fn(() => ({
      data: { makeTodoFromDraft: { __typename: 'Todo', id: 't1', title: 'Faster CSV export' } },
    }));
    const onMade = vi.fn();
    render(
      <MockedProvider
        mocks={[
          { request: { query: AgentsDocument }, result: { data: { agents: [AGENT] } } },
          openDrafts,
          {
            request: {
              query: StartDraftDocument,
              variables: { projectId: 'p1', agentId: 'a1', message: 'Export is slow' },
            },
            result: { data: { startDraft: WAITING } },
          },
          openDrafts,
          draft({ ...WAITING, agent: ANSWERED.agent, messages: [ASKED], runs: [draftRun('r1', 'running')] }),
          draft(ANSWERED),
          draft(ANSWERED),
          draft(ANSWERED),
          {
            request: {
              query: MakeTodoFromDraftDocument,
              variables: { id: 'd1', title: 'Faster CSV export', brief: 'Speed up the CSV export.' },
            },
            result: make,
          },
        ]}
      >
        <DraftDialog open onOpenChange={() => {}} projectId="p1" onMade={onMade} pollMs={20} />
      </MockedProvider>,
    );

    await user.type(await screen.findByLabelText('What do you want done?'), 'Export is slow');
    await user.click(screen.getByRole('button', { name: 'Start' }));

    expect(await screen.findByText('How big are the files?')).toBeInTheDocument();
    const title = screen.getByLabelText('Title');
    expect(title).toHaveValue('Faster export');
    expect(screen.getByLabelText('Brief')).toHaveValue('Speed up the CSV export.');

    await user.clear(title);
    await user.type(title, 'Faster CSV export');
    await user.click(screen.getByRole('button', { name: 'Make a todo' }));
    await vi.waitFor(() => expect(onMade).toHaveBeenCalledWith('Faster CSV export'));
    expect(make).toHaveBeenCalled();
  });

  it('lists a draft’s replies as runs, and opens a failed one onto what the agent was told', async () => {
    const user = userEvent.setup();
    render(
      <MockedProvider
        mocks={[
          { request: { query: AgentsDocument }, result: { data: { agents: [AGENT] } } },
          { ...openDrafts, result: { data: { drafts: [FAILED] } } },
          draft({ ...FAILED, agent: ANSWERED.agent, messages: [ASKED], runs: [FAILED_REPLY] }),
          runMock(fullRun('r2', 'error', { ...FAILED_REPLY, userPrompt: 'Them: Export is slow' })),
        ]}
      >
        <DraftDialog open onOpenChange={() => {}} projectId="p1" pollMs={20} />
      </MockedProvider>,
    );

    await user.click(await screen.findByRole('button', { name: 'Untitled draft' }));
    const replies = await screen.findByRole('list', { name: 'Replies' });
    const [reply] = within(replies).getAllByRole('listitem');
    // Within a draft the row needs no draft's name and no mark saying it is one.
    expect(within(reply).getByText('Draft reply · Planner')).toBeInTheDocument();
    expect(within(reply).getByText('Failed')).toBeInTheDocument();
    expect(within(reply).queryByText('Draft')).not.toBeInTheDocument();

    await user.click(within(reply).getByRole('button', { name: 'Draft reply · Planner, error' }));
    expect(await within(reply).findByText('The model timed out.')).toBeInTheDocument();
  });

  it('asks for an agent when there is none', async () => {
    render(
      <MockedProvider mocks={[{ request: { query: AgentsDocument }, result: { data: { agents: [] } } }, openDrafts]}>
        <DraftDialog open onOpenChange={() => {}} projectId="p1" />
      </MockedProvider>,
    );
    expect(await screen.findByText('Add an agent in Settings to talk a request over.')).toBeInTheDocument();
  });
});
