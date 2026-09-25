import { MockedProvider } from '@apollo/client/testing';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentModelsDocument,
  AgentsDocument,
  CreateAgentDocument,
  McpProbeDocument,
  TestMcpServerDocument,
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
  mcpServers: [],
  hasApiKey: false,
};

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
      id: 'id-2',
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
      mcpServers: [{ id: 'id-1', name: 'files', url: 'http://localhost:8080/mcp' }],
    };
    const create = vi.fn(() => ({ data: { createAgent: { ...AGENT, ...values } } }));
    manager([
      agents([]),
      { request: { query: CreateAgentDocument, variables: { values } }, result: create },
      agents([AGENT]),
    ]);

    expect(await screen.findByText('No agents yet.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New agent' }));

    await user.type(screen.getByLabelText('Name'), 'Reviewer');
    await user.type(screen.getByLabelText('Base URL'), 'http://localhost:11434/v1');
    await user.type(screen.getByLabelText('Model'), 'qwen3:14b');
    await user.type(screen.getByLabelText('Temperature'), '0.2');
    await user.click(screen.getByRole('button', { name: 'Add MCP server' }));
    await user.type(screen.getByLabelText('Server 1 name'), 'files');
    await user.type(screen.getByLabelText('files URL'), 'http://localhost:8080/mcp');
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

  it('tests a server through the runner and lists its tools, or says why not', async () => {
    const user = userEvent.setup();
    // What the form does not edit rides along, so the test is of the row as saved.
    const server = { hiddenTools: ['secret'], id: 'docs', name: 'Docs', url: 'http://localhost:8080/mcp' };
    const probe = (fields: object) => ({
      __typename: 'McpProbe',
      id: 'p1',
      status: 'done',
      ok: true,
      tools: [],
      error: null,
      ...fields,
    });
    manager([
      agents([{ ...AGENT, mcpServers: [server] }]),
      {
        request: { query: TestMcpServerDocument, variables: { server: JSON.stringify(server) } },
        result: { data: { testMcpServer: { __typename: 'McpProbe', id: 'p1' } } },
      },
      {
        request: { query: McpProbeDocument, variables: { id: 'p1' } },
        result: {
          data: {
            mcpProbe: probe({
              tools: [
                { __typename: 'McpProbeTool', name: 'search', description: '' },
                { __typename: 'McpProbeTool', name: 'fetch', description: '' },
              ],
            }),
          },
        },
      },
      {
        request: { query: TestMcpServerDocument, variables: { server: JSON.stringify(server) } },
        result: { data: { testMcpServer: { __typename: 'McpProbe', id: 'p2' } } },
      },
      {
        request: { query: McpProbeDocument, variables: { id: 'p2' } },
        result: { data: { mcpProbe: probe({ id: 'p2', ok: false, error: 'connect ECONNREFUSED' }) } },
      },
    ]);

    await user.click(await screen.findByRole('button', { name: 'Edit Reviewer' }));
    await user.click(screen.getByRole('button', { name: 'Test Docs' }));
    expect(await screen.findByText('Reached. 2 tools: search, fetch')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Test Docs' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Test Docs' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('connect ECONNREFUSED');
  });
});
