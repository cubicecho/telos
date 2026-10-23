import { MockedProvider } from '@apollo/client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentInstructionsDocument,
  AgentsDocument,
  CreatePromptDocument,
  DeletePromptDocument,
  PromptsDocument,
  SetAgentInstructionsDocument,
  UpdatePromptDocument,
} from '@/lib/graphql';
import { AgentInstructionsForm, deletePromptText, PromptManager, storedInstructions } from '../prompt-settings';

let minted = 0;
vi.mock('@/lib/ids', () => ({ newId: () => `id-${++minted}` }));

const DEFAULT = 'You work one todo on a Telos board.';

function instructions(own: string | null) {
  return {
    request: { query: AgentInstructionsDocument },
    result: {
      data: { defaultAgentInstructions: DEFAULT, users: [{ __typename: 'User', id: 'u1', agentInstructions: own }] },
    },
  };
}

function setInstructions(sent: string | null, stored: string | null = sent) {
  const result = vi.fn(() => ({
    data: { setAgentInstructions: { __typename: 'User', id: 'u1', agentInstructions: stored } },
  }));
  return {
    mock: { request: { query: SetAgentInstructionsDocument, variables: { instructions: sent } }, result },
    result,
  };
}

const prompt = (name: string, body = `You are the ${name}.`) => ({
  __typename: 'Prompt',
  id: `p-${name.toLowerCase()}`,
  name,
  body,
  updatedAt: '2026-10-22T00:00:00.000Z',
});

const PROMPTS = [prompt('Planner'), prompt('Reviewer'), prompt('Worker')];

function prompts(rows: unknown[]) {
  return { request: { query: PromptsDocument }, result: { data: { prompts: rows } } };
}

/** Agents as the manager reads them: only who uses which prompt counts here. */
function agents(promptIds: (string | null)[]) {
  return {
    request: { query: AgentsDocument },
    result: {
      data: {
        agents: promptIds.map((promptId, index) => ({
          __typename: 'Agent',
          id: `a${index}`,
          name: `Agent ${index}`,
          baseUrl: null,
          model: null,
          promptId,
          temperature: null,
          maxTokens: null,
          contextLength: null,
          maxToolIterations: null,
          toolDiscovery: null,
          toolSelectModel: null,
          reasoningEffort: null,
          requestTimeoutSeconds: null,
          maxRetries: null,
          mcpServerSlugs: null,
          enabled: true,
          toolsOff: null,
          hasApiKey: false,
        })),
      },
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: MockedProvider's mock array type
function show(element: React.ReactElement, mocks: any[]) {
  render(<MockedProvider mocks={mocks}>{element}</MockedProvider>);
}

describe('storedInstructions', () => {
  it('keeps what was typed, trimmed', () => {
    expect(storedInstructions('  Use pnpm. ', DEFAULT)).toBe('Use pnpm.');
  });

  it('stores blank, or the default as it stands, as null, so the account follows the default', () => {
    expect(storedInstructions('   ', DEFAULT)).toBeNull();
    expect(storedInstructions(`${DEFAULT}\n`, DEFAULT)).toBeNull();
  });
});

describe('AgentInstructionsForm', () => {
  it('shows the default while the account has written none, and says it is sent first', async () => {
    show(<AgentInstructionsForm />, [instructions(null)]);

    expect(await screen.findByRole('textbox', { name: 'Agent instructions' })).toHaveValue(DEFAULT);
    expect(screen.getByText('The default.')).toBeInTheDocument();
    expect(screen.getByText(/Sent to every agent first/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset to default' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('saves what was typed', async () => {
    const user = userEvent.setup();
    const saved = setInstructions(`${DEFAULT} Use pnpm.`);
    show(<AgentInstructionsForm />, [instructions(null), saved.mock, instructions(`${DEFAULT} Use pnpm.`)]);

    const box = await screen.findByRole('textbox', { name: 'Agent instructions' });
    const save = screen.getByRole('button', { name: 'Save agent instructions' });
    expect(save).toBeDisabled();
    await user.type(box, ' Use pnpm.');
    await user.click(save);

    await waitFor(() => expect(saved.result).toHaveBeenCalled());
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('resets the account’s own to the default, once asked twice', async () => {
    const user = userEvent.setup();
    const reset = setInstructions(null);
    show(<AgentInstructionsForm />, [instructions('Only ever use pnpm.'), reset.mock]);

    expect(await screen.findByRole('textbox', { name: 'Agent instructions' })).toHaveValue('Only ever use pnpm.');
    expect(screen.getByText('Your own, in place of the default.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reset to default' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Reset' }));

    await waitFor(() => expect(reset.result).toHaveBeenCalled());
    expect(await screen.findByRole('textbox', { name: 'Agent instructions' })).toHaveValue(DEFAULT);
  });
});

describe('deletePromptText', () => {
  it('says how many agents lose the prompt', () => {
    expect(deletePromptText(0)).toMatch(/^No agent uses it/);
    expect(deletePromptText(1)).toMatch(/^1 agent uses it and is left with no prompt/);
    expect(deletePromptText(3)).toMatch(/^3 agents use it and are left with no prompt/);
  });
});

describe('PromptManager', () => {
  it('lists the prompts, the seeded ones among them, with how many agents use each', async () => {
    show(<PromptManager />, [prompts(PROMPTS), agents(['p-worker', 'p-worker', 'p-reviewer', null])]);

    expect(await screen.findByText('Planner')).toBeInTheDocument();
    expect(screen.getByText('You are the Worker.')).toBeInTheDocument();
    expect(await screen.findByText('2 agents')).toBeInTheDocument();
    expect(screen.getByText('1 agent')).toBeInTheDocument();
    expect(screen.getByText('0 agents')).toBeInTheDocument();
  });

  it('adds a prompt, refusing a name another prompt has', async () => {
    minted = 0;
    const user = userEvent.setup();
    const values = { id: 'id-1', name: 'Writer', body: 'You write the docs.' };
    const create = vi.fn(() => ({ data: { createPrompt: { ...prompt('Writer', values.body), id: 'id-1' } } }));
    show(<PromptManager />, [
      prompts(PROMPTS),
      agents([]),
      { request: { query: CreatePromptDocument, variables: { values } }, result: create },
      prompts([...PROMPTS, { ...prompt('Writer', values.body), id: 'id-1' }]),
    ]);

    await user.click(await screen.findByRole('button', { name: 'New prompt' }));
    await user.type(screen.getByLabelText('Name'), 'worker');
    expect(await screen.findByText('Another prompt has that name.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), ' Writer ');
    await user.type(screen.getByLabelText('Prompt'), 'You write the docs.');
    await user.click(screen.getByRole('button', { name: 'Create prompt' }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('edits a seeded prompt', async () => {
    const user = userEvent.setup();
    const set = { name: 'Worker', body: 'You are the Worker. Run the tests.' };
    const update = vi.fn(() => ({ data: { updatePrompt: prompt('Worker', set.body) } }));
    show(<PromptManager />, [
      prompts(PROMPTS),
      agents([]),
      { request: { query: UpdatePromptDocument, variables: { id: 'p-worker', set } }, result: update },
    ]);

    await user.click(await screen.findByRole('button', { name: 'Edit Worker' }));
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText('Prompt'), ' Run the tests.');
    await user.click(save);

    await waitFor(() => expect(update).toHaveBeenCalled());
  });

  it('deletes a prompt once asked twice, saying which agents lose it', async () => {
    const user = userEvent.setup();
    const drop = vi.fn(() => ({ data: { deletePrompt: { __typename: 'Prompt', id: 'p-worker' } } }));
    show(<PromptManager />, [
      prompts(PROMPTS),
      agents(['p-worker', 'p-worker']),
      { request: { query: DeletePromptDocument, variables: { id: 'p-worker' } }, result: drop },
      prompts(PROMPTS.filter((row) => row.id !== 'p-worker')),
      agents([null, null]),
    ]);

    await screen.findByText('2 agents');
    await user.click(screen.getByRole('button', { name: 'Delete Worker' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/2 agents use it and are left with no prompt/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(drop).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('Worker')).not.toBeInTheDocument());
  });
});
