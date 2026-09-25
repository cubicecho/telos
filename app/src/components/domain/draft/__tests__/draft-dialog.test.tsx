import { MockedProvider } from '@apollo/client/testing';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentsDocument,
  DraftDocument,
  MakeTodoFromDraftDocument,
  OpenDraftsDocument,
  StartDraftDocument,
} from '@/lib/graphql';
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
          draft({ ...WAITING, agent: ANSWERED.agent, messages: [ASKED] }),
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

  it('asks for an agent when there is none', async () => {
    render(
      <MockedProvider mocks={[{ request: { query: AgentsDocument }, result: { data: { agents: [] } } }, openDrafts]}>
        <DraftDialog open onOpenChange={() => {}} projectId="p1" />
      </MockedProvider>,
    );
    expect(await screen.findByText('Add an agent in Settings to talk a request over.')).toBeInTheDocument();
  });
});
