import { MockedProvider } from '@apollo/client/testing';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GraphQLError } from 'graphql';
import { describe, expect, it } from 'vitest';
import { ApiKeysDocument, McpToolsDocument, SetApiKeyToolsDocument } from '@/lib/graphql';
import { ApiKeyManager } from '../api-key-manager';

const KEY = {
  __typename: 'ApiKey',
  id: 'k1',
  name: 'Claude Code',
  start: 'telos_ab',
  createdAt: '2026-09-01T10:00:00.000Z',
  lastRequest: null,
  expiresAt: null,
  toolsOff: ['delete_todo'],
};

const TOOLS = [
  { name: 'projects', description: 'The projects open to AI.\nMore.', writes: false, runDefault: true },
  { name: 'submit_request', description: 'Hands work to a project.', writes: true, runDefault: false },
  { name: 'delete_todo', description: 'Deletes a todo for good.', writes: true, runDefault: false },
].map((tool) => ({ __typename: 'McpTool', forRuns: true, ...tool }));

const keys = { request: { query: ApiKeysDocument }, result: { data: { apiKeys: [KEY] } } };
const tools = { request: { query: McpToolsDocument }, result: { data: { mcpTools: TOOLS } } };

/**
 * The mutation a switch sends, answered with the key as it then is.
 *
 * @param off The tools the key should have off.
 * @returns The mock, and whether it was called.
 */
function setTools(off: string[]) {
  const sent = { called: false };
  return {
    sent,
    mock: {
      request: { query: SetApiKeyToolsDocument, variables: { id: KEY.id, off } },
      result: () => {
        sent.called = true;
        return { data: { setApiKeyTools: { ...KEY, toolsOff: off } } };
      },
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: MockedProvider's mock array type
async function openTools(mocks: any[]) {
  const user = userEvent.setup();
  render(
    <MockedProvider mocks={[keys, tools, ...mocks]}>
      <ApiKeyManager />
    </MockedProvider>,
  );
  expect(await screen.findByText(/1 tool off/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Tools for Claude Code' }));
  await screen.findByRole('switch', { name: 'projects' });
  return user;
}

describe('a key’s tools', () => {
  it('shows a switch per tool, on unless the key has it off', async () => {
    await openTools([]);
    expect(screen.getByRole('switch', { name: 'projects' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'submit_request' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'delete_todo' })).not.toBeChecked();
    expect(screen.getByText('The projects open to AI.')).toBeInTheDocument();
  });

  it('saves a switch as it is flipped, keeping the others', async () => {
    const save = setTools(['submit_request', 'delete_todo']);
    const user = await openTools([save.mock]);
    await user.click(screen.getByRole('switch', { name: 'submit_request' }));
    await waitFor(() => expect(save.sent.called).toBe(true));
  });

  it('turns every writing tool off at once', async () => {
    const save = setTools(['submit_request', 'delete_todo']);
    const user = await openTools([save.mock]);
    await user.click(screen.getByRole('button', { name: 'Read only' }));
    await waitFor(() => expect(save.sent.called).toBe(true));
  });

  it('says why a save failed', async () => {
    const user = await openTools([
      {
        request: { query: SetApiKeyToolsDocument, variables: { id: KEY.id, off: [] } },
        result: { errors: [new GraphQLError('API key not found')] },
      },
    ]);
    await user.click(screen.getByRole('button', { name: 'All on' }));
    expect(await screen.findByText('API key not found')).toBeInTheDocument();
  });
});
