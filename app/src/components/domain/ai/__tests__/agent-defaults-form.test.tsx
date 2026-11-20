import { MockedProvider } from '@apollo/client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentDefaultsDocument,
  AgentModelsDocument,
  SetAgentDefaultsApiKeyDocument,
  SetAgentDefaultsDocument,
} from '@/lib/graphql';
import { AgentDefaultsForm } from '../agent-defaults-form';

const BUILT_IN = {
  __typename: 'ResolvedAgentSettings',
  baseUrl: '',
  model: '',
  remoteAgent: false,
  temperature: 0.7,
  maxTokens: 0,
  contextLength: 0,
  maxToolIterations: 20,
  toolDiscovery: false,
  toolSelectModel: '',
  reasoningEffort: '',
  reasoningReplay: 'all',
  requestTimeoutSeconds: null,
  maxRetries: 0,
};

const BLANK = {
  __typename: 'AgentDefaults',
  id: 'u1',
  baseUrl: null as string | null,
  model: null as string | null,
  remoteAgent: null as boolean | null,
  temperature: null,
  maxTokens: null,
  contextLength: null,
  maxToolIterations: null,
  toolDiscovery: null,
  toolSelectModel: null,
  reasoningEffort: null,
  reasoningReplay: null,
  requestTimeoutSeconds: null,
  maxRetries: null,
  hasApiKey: false,
  resolved: BUILT_IN,
  builtIn: BUILT_IN,
};

const read = (row: typeof BLANK) => ({
  request: { query: AgentDefaultsDocument },
  result: { data: { agentDefaults: row } },
});

/** A model as an endpoint lists it: an ordinary one unless it says more. */
function modelEntry(entry: {
  id: string;
  contextLength?: number;
  name?: string;
  description?: string;
  remoteAgent?: true;
}) {
  return { __typename: 'AgentModel', contextLength: null, name: null, description: null, remoteAgent: false, ...entry };
}

/** ai-router's listing: one of its agents, with its card, beside a plain model. */
const ROUTER_URL = 'http://router.local/v1';
const routerModels = {
  request: { query: AgentModelsDocument, variables: { baseUrl: ROUTER_URL, agentId: null, apiKey: null } },
  result: {
    data: {
      agentModels: [
        modelEntry({ id: 'qwen3:14b', contextLength: 8192 }),
        modelEntry({
          id: 'triage',
          name: 'Triage',
          description: 'Sorts new issues',
          contextLength: 32768,
          remoteAgent: true,
        }),
      ],
    },
  },
};

// biome-ignore lint/suspicious/noExplicitAny: MockedProvider's mock array type
function form(mocks: any[]) {
  render(
    <MockedProvider mocks={mocks}>
      <AgentDefaultsForm />
    </MockedProvider>,
  );
}

/** Opens the fold the fields sit behind, once the defaults have loaded. */
async function unfold(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /Endpoint, model and limits/ }));
}

describe('AgentDefaultsForm', () => {
  it('starts folded, naming the stored model and endpoint', async () => {
    const user = userEvent.setup();
    form([read({ ...BLANK, baseUrl: 'http://llm.local/v1', model: 'qwen3:14b' })]);

    const fold = await screen.findByRole('button', { name: /Endpoint, model and limits/ });
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('qwen3:14b · http://llm.local/v1')).toBeInTheDocument();
    expect(screen.queryByLabelText('Temperature')).not.toBeInTheDocument();

    await user.click(fold);
    expect(screen.getByLabelText('Temperature')).toBeInTheDocument();
  });

  it('shows what a blank falls to, and saves zero as a value and blank as null', async () => {
    const user = userEvent.setup();
    const values = {
      baseUrl: 'http://llm.local/v1',
      model: null,
      remoteAgent: null,
      temperature: 0,
      maxTokens: null,
      contextLength: null,
      maxToolIterations: null,
      toolDiscovery: null,
      toolSelectModel: null,
      reasoningEffort: null,
      reasoningReplay: null,
      requestTimeoutSeconds: null,
      maxRetries: null,
    };
    const save = vi.fn(() => ({
      data: { setAgentDefaults: { ...BLANK, baseUrl: values.baseUrl, temperature: 0 } },
    }));
    form([read(BLANK), { request: { query: SetAgentDefaultsDocument, variables: { values } }, result: save }]);
    await unfold(user);

    const temperature = await screen.findByLabelText('Temperature');
    expect(temperature).toHaveAttribute('placeholder', '0.7');
    expect(screen.getByLabelText('Request timeout (seconds)')).toHaveAttribute('placeholder', 'No limit');
    expect(screen.getByText('No key')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Base URL'), 'http://llm.local/v1');
    await user.type(temperature, '0');
    await user.click(screen.getByRole('button', { name: 'Save defaults' }));

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('refuses a temperature the runner would drop', async () => {
    const user = userEvent.setup();
    form([read(BLANK)]);
    await unfold(user);

    await user.type(await screen.findByLabelText('Temperature'), '5');
    expect(await screen.findByText('Must be at most 2.')).toBeInTheDocument();
  });

  it('sets the default key without ever reading it', async () => {
    const user = userEvent.setup();
    const setKey = vi.fn(() => ({
      data: { setAgentDefaultsApiKey: { __typename: 'AgentDefaults', id: 'u1', hasApiKey: true } },
    }));
    form([
      read(BLANK),
      { request: { query: SetAgentDefaultsApiKeyDocument, variables: { apiKey: 'sk-default' } }, result: setKey },
    ]);

    await user.click(await screen.findByRole('button', { name: 'Set default key' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('API key'), 'sk-default');
    await user.click(within(dialog).getByRole('button', { name: 'Set key' }));

    await waitFor(() => expect(setKey).toHaveBeenCalled());
    expect(await screen.findByText('Key set')).toBeInTheDocument();
  });

  it('greys out what a remote default model runs itself, and keeps its iteration cap', async () => {
    const user = userEvent.setup();
    form([read({ ...BLANK, baseUrl: ROUTER_URL, model: 'triage', remoteAgent: true }), routerModels]);
    await unfold(user);

    expect(await screen.findByText('Sorts new issues')).toBeInTheDocument();
    expect(screen.getByText(/^This model is a remote agent/)).toBeInTheDocument();
    for (const label of ['Temperature', 'Max tokens']) expect(screen.getByLabelText(label)).toBeDisabled();
    for (const label of ['Reasoning effort', 'Send thinking back to the model', 'Tool discovery']) {
      expect(screen.getByRole('combobox', { name: label })).toBeDisabled();
    }
    expect(screen.getByRole('combobox', { name: 'Tool selection model' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByLabelText('Max tool iterations')).toBeEnabled();
    expect(screen.getByText(/^For a remote agent, this limits only/)).toBeInTheDocument();
  });

  it('sets the flag from the model picked, and clears it with the model', async () => {
    const user = userEvent.setup();
    const saved: Array<Record<string, unknown>> = [];
    // The server answers with what was saved, which the form then holds.
    const save = vi.fn((variables: { values: Record<string, unknown> }) => {
      saved.push(variables.values);
      return { data: { setAgentDefaults: { ...BLANK, ...variables.values } } };
    });
    form([
      read({ ...BLANK, baseUrl: ROUTER_URL }),
      routerModels,
      { request: { query: SetAgentDefaultsDocument }, variableMatcher: () => true, result: save, maxUsageCount: 3 },
    ]);
    await unfold(user);
    expect(await screen.findByText('2 models at http://router.local/v1')).toBeInTheDocument();
    /** Picks a model and saves, once the save before it has landed. */
    const pickAndSave = async (option: RegExp) => {
      const before = saved.length;
      await user.click(screen.getByRole('combobox', { name: 'Model' }));
      await user.click(await screen.findByRole('option', { name: option }));
      await user.click(screen.getByRole('button', { name: 'Save defaults' }));
      await waitFor(() => expect(saved).toHaveLength(before + 1));
    };

    await pickAndSave(/triage/);
    expect(screen.getByLabelText('Temperature')).toBeDisabled();
    await pickAndSave(/qwen3:14b/);
    expect(screen.getByLabelText('Temperature')).toBeEnabled();
    await pickAndSave(/^None/);

    expect(saved.map(({ model, remoteAgent, contextLength }) => ({ model, remoteAgent, contextLength }))).toEqual([
      { model: 'triage', remoteAgent: true, contextLength: 32768 },
      // A typed length stays: only a remote agent's card states its own.
      { model: 'qwen3:14b', remoteAgent: false, contextLength: 32768 },
      { model: null, remoteAgent: null, contextLength: 32768 },
    ]);
  });

  it('lists the stored endpoint’s models, and saves a key typed beside it', async () => {
    const user = userEvent.setup();
    const stored = { ...BLANK, baseUrl: 'http://llm.local/v1' };
    const setKey = vi.fn(() => ({
      data: { setAgentDefaultsApiKey: { __typename: 'AgentDefaults', id: 'u1', hasApiKey: true } },
    }));
    form([
      read(stored),
      {
        request: {
          query: AgentModelsDocument,
          variables: { baseUrl: 'http://llm.local/v1', agentId: null, apiKey: null },
        },
        result: { data: { agentModels: [modelEntry({ id: 'qwen3:14b', contextLength: 40960 })] } },
      },
      {
        request: { query: SetAgentDefaultsDocument },
        variableMatcher: () => true,
        result: { data: { setAgentDefaults: stored } },
      },
      { request: { query: SetAgentDefaultsApiKeyDocument, variables: { apiKey: 'sk-inline' } }, result: setKey },
    ]);
    await unfold(user);

    expect(await screen.findByText('1 model at http://llm.local/v1')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeInTheDocument();

    await user.type(screen.getByLabelText('API key'), 'sk-inline');
    await user.click(screen.getByRole('button', { name: 'Save defaults' }));

    await waitFor(() => expect(setKey).toHaveBeenCalled());
    expect(screen.getByLabelText('API key')).toHaveValue('');
  });
});
