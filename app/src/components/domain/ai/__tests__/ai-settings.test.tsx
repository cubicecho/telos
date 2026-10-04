import { MockedProvider } from '@apollo/client/testing';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  AgentDefaultsDocument,
  AgentsDocument,
  AiStateDocument,
  ApiKeysDocument,
  McpServersDocument,
  SetAiEnabledDocument,
  SetInstanceAiEnabledDocument,
} from '@/lib/graphql';
import { AgentSettings, AiSettings } from '../ai-settings';

function aiState(instance: boolean, account: boolean, { available = instance, admin = false } = {}) {
  return {
    request: { query: AiStateDocument },
    result: {
      data: {
        authConfig: { __typename: 'AuthConfig', ai: instance, aiAvailable: available },
        users: [{ __typename: 'User', id: 'u1', aiEnabled: account, isAdmin: admin }],
      },
    },
  };
}

const KEY = {
  __typename: 'ApiKey',
  id: 'k1',
  name: 'Claude Code',
  start: 'telos_ab',
  createdAt: '2026-09-01T10:00:00.000Z',
  lastRequest: null,
  expiresAt: null,
  toolsOff: [],
};

const keys = { request: { query: ApiKeysDocument }, result: { data: { apiKeys: [KEY] } } };
const agents = { request: { query: AgentsDocument }, result: { data: { agents: [] } } };
const servers = { request: { query: McpServersDocument }, result: { data: { mcpServers: [] } } };

// biome-ignore lint/suspicious/noExplicitAny: MockedProvider's mock array type
function settings(mocks: any[], Component = AiSettings) {
  render(
    <MockedProvider mocks={mocks}>
      <Component />
    </MockedProvider>,
  );
}

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
  reasoningEffort: '',
  requestTimeoutSeconds: null,
  maxRetries: 0,
};

const defaults = {
  request: { query: AgentDefaultsDocument },
  result: {
    data: {
      agentDefaults: {
        __typename: 'AgentDefaults',
        id: 'u1',
        baseUrl: null,
        model: null,
        temperature: null,
        maxTokens: null,
        contextLength: null,
        maxToolIterations: null,
        toolDiscovery: null,
        toolSelectModel: null,
        reasoningEffort: null,
        requestTimeoutSeconds: null,
        maxRetries: null,
        hasApiKey: false,
        resolved: BUILT_IN,
        builtIn: BUILT_IN,
      },
    },
  },
};

describe('AiSettings', () => {
  it('draws nothing at all when the instance has no AI', async () => {
    settings([aiState(false, false)]);
    // Give the query its answer before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText('AI')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('draws nothing for someone who is not an admin while the instance has AI switched off', async () => {
    settings([aiState(false, false, { available: true })]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('draws nothing for an admin either when the server offers no AI', async () => {
    settings([aiState(false, false, { available: false, admin: true })]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it("gives an admin the instance's switch, and only that, while it is off", async () => {
    settings([aiState(false, false, { available: true, admin: true })]);
    expect(await screen.findByRole('switch', { name: 'AI on this instance' })).not.toBeChecked();
    expect(screen.queryByRole('switch', { name: 'Use AI on this account' })).not.toBeInTheDocument();
  });

  it("turns the instance on and then offers the account's switch", async () => {
    const user = userEvent.setup();
    settings([
      aiState(false, false, { available: true, admin: true }),
      {
        request: { query: SetInstanceAiEnabledDocument, variables: { enabled: true } },
        result: { data: { setInstanceAiEnabled: { __typename: 'AuthConfig', ai: true, aiAvailable: true } } },
      },
      aiState(true, false, { admin: true }),
    ]);

    await user.click(await screen.findByRole('switch', { name: 'AI on this instance' }));

    expect(await screen.findByRole('switch', { name: 'Use AI on this account' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'AI on this instance' })).toBeChecked();
  });

  it('shows only the switch, and no keys, while the account has AI off', async () => {
    settings([aiState(true, false)]);
    expect(await screen.findByRole('switch', { name: 'Use AI on this account' })).not.toBeChecked();
    expect(screen.queryByText('API keys')).not.toBeInTheDocument();
  });

  it('turns AI on and then lists the keys, leaving the agents and servers to their own tabs', async () => {
    const user = userEvent.setup();
    settings([
      aiState(true, false),
      {
        request: { query: SetAiEnabledDocument, variables: { enabled: true } },
        result: { data: { setAiEnabled: { __typename: 'User', id: 'u1', aiEnabled: true } } },
      },
      keys,
    ]);

    await user.click(await screen.findByRole('switch', { name: 'Use AI on this account' }));

    expect(await screen.findByText('API keys')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeInTheDocument());
    expect(screen.queryByText('No agents yet.')).not.toBeInTheDocument();
    expect(screen.queryByText('No servers yet.')).not.toBeInTheDocument();
  });
});

describe('AgentSettings', () => {
  it('draws nothing while the account has AI off', async () => {
    settings([aiState(true, false)], AgentSettings);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText('No agents yet.')).not.toBeInTheDocument();
  });

  it('lists the agents once AI is on', async () => {
    settings([aiState(true, true), defaults, defaults, defaults, agents, servers], AgentSettings);
    expect(await screen.findByText('No agents yet.')).toBeInTheDocument();
  });
});
