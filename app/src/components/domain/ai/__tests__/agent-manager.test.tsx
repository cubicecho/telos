import { MockedProvider } from '@apollo/client/testing';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentModelsDocument,
  AgentsDocument,
  CreateAgentDocument,
  McpServersDocument,
  McpToolsDocument,
  UpdateAgentDocument,
} from '@/lib/graphql';
import { AgentManager } from '../agent-manager';

// Ids are minted on the client; pinning them is what lets the mock name the
// exact create the dialog sends.
let minted = 0;
vi.mock('@/lib/ids', () => ({ newId: () => `id-${++minted}` }));

const AGENT = {
  __typename: 'Agent',
  id: 'a1',
  name: 'Reviewer',
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
  mcpServerSlugs: null,
  toolsOff: null,
  hasApiKey: false,
};

// One of each kind: a read and a write a run has by default, a write it does
// not, and a tool no run may have.
const TOOLS = [
  { name: 'todos', writes: false, forRuns: true, runDefault: true },
  { name: 'create_todo', writes: true, forRuns: true, runDefault: true },
  { name: 'move_todo', writes: true, forRuns: true, runDefault: false },
  { name: 'record_artifact', writes: true, forRuns: false, runDefault: false },
].map((tool) => ({ __typename: 'McpTool', description: `What ${tool.name} does.\nMore.`, ...tool }));

const tools = { request: { query: McpToolsDocument }, result: { data: { mcpTools: TOOLS } } };

const SERVER = {
  __typename: 'McpServer',
  id: 's1',
  slug: 'docs',
  name: 'Docs',
  url: 'http://localhost:8080/mcp',
  command: null,
  args: [],
  hiddenTools: [],
  hooks: [],
  enabled: true,
  checkedAt: null,
  checkOk: null,
  checkError: null,
  tools: [],
  headerNames: [],
  envNames: [],
};

function servers(rows: unknown[]) {
  return { request: { query: McpServersDocument }, result: { data: { mcpServers: rows } } };
}

function agents(rows: unknown[]) {
  return { request: { query: AgentsDocument }, result: { data: { agents: rows } } };
}

// biome-ignore lint/suspicious/noExplicitAny: MockedProvider's mock array type
function manager(mocks: any[]) {
  render(
    <MockedProvider mocks={mocks}>
      <AgentManager />
    </MockedProvider>,
  );
}

describe('AgentManager', () => {
  it('lists the agents, and says whether each has a key', async () => {
    manager([agents([AGENT, { ...AGENT, id: 'a2', name: 'Writer', hasApiKey: true }])]);

    expect(await screen.findByText('Reviewer')).toBeInTheDocument();
    expect(screen.getByText('Writer')).toBeInTheDocument();
    expect(screen.getByText('No key')).toBeInTheDocument();
    expect(screen.getByText('Key set')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set key' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace key' })).toBeInTheDocument();
  });

  it('creates an agent with what was typed, and nothing it was not told', async () => {
    minted = 0;
    const user = userEvent.setup();
    const values = {
      id: 'id-1',
      name: 'Reviewer',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen3:14b',
      systemPrompt: null,
      temperature: 0.2,
      maxTokens: null,
      contextLength: null,
      maxToolIterations: 20,
      toolDiscovery: false,
      toolSelectModel: null,
      requestTimeoutSeconds: null,
      maxRetries: null,
      // Every server the account has, which is what a new agent starts with.
      mcpServerSlugs: null,
      // The run default: reading, adding work and notes.
      toolsOff: null,
    };
    const create = vi.fn(() => ({ data: { createAgent: { ...AGENT, ...values } } }));
    manager([
      agents([]),
      servers([SERVER]),
      tools,
      { request: { query: CreateAgentDocument, variables: { values } }, result: create },
      agents([AGENT]),
    ]);

    expect(await screen.findByText('No agents yet.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New agent' }));

    await user.type(screen.getByLabelText('Name'), 'Reviewer');
    await user.type(screen.getByLabelText('Base URL'), 'http://localhost:11434/v1');
    await user.type(screen.getByLabelText('Model'), 'qwen3:14b');
    await user.type(screen.getByLabelText('Temperature'), '0.2');
    expect(screen.getByRole('checkbox', { name: 'Every server' })).toBeChecked();
    expect(await screen.findByRole('switch', { name: 'create_todo' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'move_todo' })).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('will not create an agent without a model', async () => {
    const user = userEvent.setup();
    manager([agents([])]);

    await user.click(await screen.findByRole('button', { name: 'New agent' }));
    await user.type(screen.getByLabelText('Name'), 'Reviewer');
    await user.type(screen.getByLabelText('Base URL'), 'http://localhost:11434/v1');
    await user.click(screen.getByRole('button', { name: 'Create agent' }));

    expect(await screen.findByText('An agent needs a model.')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('picks a model from what the endpoint lists, and takes its context length', async () => {
    const user = userEvent.setup();
    manager([
      agents([AGENT]),
      {
        request: { query: AgentModelsDocument, variables: { baseUrl: 'http://localhost:11434/v1', agentId: 'a1' } },
        result: {
          data: {
            agentModels: [
              { __typename: 'AgentModel', id: 'llama3:8b', contextLength: 8192 },
              { __typename: 'AgentModel', id: 'qwen3:14b', contextLength: null },
            ],
          },
        },
      },
    ]);

    await user.click(await screen.findByRole('button', { name: 'Edit Reviewer' }));
    await user.click(screen.getByRole('button', { name: 'Pick from the endpoint’s models' }));
    await user.click(await screen.findByRole('menuitem', { name: /llama3:8b/ }));

    expect(screen.getByLabelText('Model')).toHaveValue('llama3:8b');
    expect(screen.getByLabelText('Context length')).toHaveValue('8192');
  });

  it('narrows an agent to the servers ticked, starting from the ones it reaches now', async () => {
    const user = userEvent.setup();
    const memory = { ...SERVER, id: 's2', slug: 'memory', name: 'Memory' };
    const update = vi.fn((variables: { set: { mcpServerSlugs: string[] } }) => ({
      data: { updateAgent: { ...AGENT, mcpServerSlugs: variables.set.mcpServerSlugs } },
    }));
    manager([
      agents([AGENT]),
      servers([SERVER, memory]),
      { request: { query: UpdateAgentDocument }, variableMatcher: () => true, result: update },
    ]);

    await user.click(await screen.findByRole('button', { name: 'Edit Reviewer' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Every server' }));
    expect(await screen.findByRole('checkbox', { name: 'Docs' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Memory' })).toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: 'Memory' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][0]).toMatchObject({ id: 'a1', set: { mcpServerSlugs: ['docs'] } });
  });

  it('shows a server the agent names that is gone, and lets it be taken off the list', async () => {
    const user = userEvent.setup();
    const update = vi.fn((variables: { set: { mcpServerSlugs: string[] } }) => ({
      data: { updateAgent: { ...AGENT, mcpServerSlugs: variables.set.mcpServerSlugs } },
    }));
    manager([
      agents([{ ...AGENT, mcpServerSlugs: ['docs', 'gone'] }]),
      servers([SERVER]),
      { request: { query: UpdateAgentDocument }, variableMatcher: () => true, result: update },
    ]);

    await user.click(await screen.findByRole('button', { name: 'Edit Reviewer' }));
    expect(await screen.findByText('“gone” no longer exists, so it is left out.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove gone' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][0]).toMatchObject({ set: { mcpServerSlugs: ['docs'] } });
  });

  it('switches a run’s tools from the defaults, without offering one no run may have', async () => {
    const user = userEvent.setup();
    const update = vi.fn((variables: { set: { toolsOff: string[] | null } }) => ({
      data: { updateAgent: { ...AGENT, toolsOff: variables.set.toolsOff } },
    }));
    manager([
      agents([AGENT]),
      servers([SERVER]),
      tools,
      { request: { query: UpdateAgentDocument }, variableMatcher: () => true, result: update },
    ]);

    await user.click(await screen.findByRole('button', { name: 'Edit Reviewer' }));
    expect(await screen.findByRole('switch', { name: 'todos' })).toBeChecked();
    expect(screen.queryByRole('switch', { name: 'record_artifact' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Defaults' })).toBeDisabled();
    // Turning one on keeps the rest as the defaults had them.
    await user.click(screen.getByRole('switch', { name: 'move_todo' }));
    expect(screen.getByRole('switch', { name: 'move_todo' })).toBeChecked();
    await user.click(screen.getByRole('switch', { name: 'create_todo' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][0]).toMatchObject({ id: 'a1', set: { toolsOff: ['create_todo'] } });
  });

  it('goes back to the defaults, which follow the door', async () => {
    const user = userEvent.setup();
    const update = vi.fn((variables: { set: { toolsOff: string[] | null } }) => ({
      data: { updateAgent: { ...AGENT, toolsOff: variables.set.toolsOff } },
    }));
    manager([
      agents([{ ...AGENT, toolsOff: [] }]),
      servers([SERVER]),
      tools,
      { request: { query: UpdateAgentDocument }, variableMatcher: () => true, result: update },
    ]);

    await user.click(await screen.findByRole('button', { name: 'Edit Reviewer' }));
    expect(await screen.findByRole('switch', { name: 'move_todo' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Defaults' }));
    expect(screen.getByRole('switch', { name: 'move_todo' })).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][0]).toMatchObject({ set: { toolsOff: null } });
  });
});
