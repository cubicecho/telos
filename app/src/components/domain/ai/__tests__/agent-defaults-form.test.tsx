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
  temperature: 0.7,
  maxTokens: 0,
  contextLength: 0,
  maxToolIterations: 20,
  toolDiscovery: false,
  toolSelectModel: '',
  requestTimeoutSeconds: null,
  maxRetries: 0,
};

const BLANK = {
  __typename: 'AgentDefaults',
  id: 'u1',
  baseUrl: null as string | null,
  model: null,
  temperature: null,
  maxTokens: null,
  contextLength: null,
  maxToolIterations: null,
  toolDiscovery: null,
  toolSelectModel: null,
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

// biome-ignore lint/suspicious/noExplicitAny: MockedProvider's mock array type
function form(mocks: any[]) {
  render(
    <MockedProvider mocks={mocks}>
      <AgentDefaultsForm />
    </MockedProvider>,
  );
}

describe('AgentDefaultsForm', () => {
  it('shows what a blank falls to, and saves zero as a value and blank as null', async () => {
    const user = userEvent.setup();
    const values = {
      baseUrl: 'http://llm.local/v1',
      model: null,
      temperature: 0,
      maxTokens: null,
      contextLength: null,
      maxToolIterations: null,
      toolDiscovery: null,
      toolSelectModel: null,
      requestTimeoutSeconds: null,
      maxRetries: null,
    };
    const save = vi.fn(() => ({
      data: { setAgentDefaults: { ...BLANK, baseUrl: values.baseUrl, temperature: 0 } },
    }));
    form([read(BLANK), { request: { query: SetAgentDefaultsDocument, variables: { values } }, result: save }]);

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
        result: { data: { agentModels: [{ __typename: 'AgentModel', id: 'qwen3:14b', contextLength: 40960 }] } },
      },
      {
        request: { query: SetAgentDefaultsDocument },
        variableMatcher: () => true,
        result: { data: { setAgentDefaults: stored } },
      },
      { request: { query: SetAgentDefaultsApiKeyDocument, variables: { apiKey: 'sk-inline' } }, result: setKey },
    ]);

    expect(await screen.findByText('1 model at http://llm.local/v1')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeInTheDocument();

    await user.type(screen.getByLabelText('API key'), 'sk-inline');
    await user.click(screen.getByRole('button', { name: 'Save defaults' }));

    await waitFor(() => expect(setKey).toHaveBeenCalled());
    expect(screen.getByLabelText('API key')).toHaveValue('');
  });
});
