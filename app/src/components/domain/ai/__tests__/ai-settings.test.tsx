import { MockedProvider } from '@apollo/client/testing';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AgentsDocument, AiStateDocument, ApiKeysDocument, SetAiEnabledDocument } from '@/lib/graphql';
import { AiSettings } from '../ai-settings';

function aiState(instance: boolean, account: boolean) {
  return {
    request: { query: AiStateDocument },
    result: {
      data: {
        authConfig: { __typename: 'AuthConfig', ai: instance },
        users: [{ __typename: 'User', id: 'u1', aiEnabled: account }],
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
};

const keys = { request: { query: ApiKeysDocument }, result: { data: { apiKeys: [KEY] } } };
const agents = { request: { query: AgentsDocument }, result: { data: { agents: [] } } };

// biome-ignore lint/suspicious/noExplicitAny: MockedProvider's mock array type
function settings(mocks: any[]) {
  render(
    <MockedProvider mocks={mocks}>
      <AiSettings />
    </MockedProvider>,
  );
}

describe('AiSettings', () => {
  it('draws nothing at all when the instance has no AI', async () => {
    settings([aiState(false, false)]);
    // Give the query its answer before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText('AI')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('shows only the switch, and no keys, while the account has AI off', async () => {
    settings([aiState(true, false)]);
    expect(await screen.findByRole('switch', { name: 'Use AI on this account' })).not.toBeChecked();
    expect(screen.queryByText('API keys')).not.toBeInTheDocument();
  });

  it('turns AI on and then lists the keys and the agents', async () => {
    const user = userEvent.setup();
    settings([
      aiState(true, false),
      {
        request: { query: SetAiEnabledDocument, variables: { enabled: true } },
        result: { data: { setAiEnabled: { __typename: 'User', id: 'u1', aiEnabled: true } } },
      },
      keys,
      agents,
    ]);

    await user.click(await screen.findByRole('switch', { name: 'Use AI on this account' }));

    expect(await screen.findByText('API keys')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeInTheDocument());
    expect(await screen.findByText('No agents yet.')).toBeInTheDocument();
  });
});
