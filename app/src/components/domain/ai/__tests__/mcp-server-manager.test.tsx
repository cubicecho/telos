import { MockedProvider } from '@apollo/client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GraphQLError } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentsDocument,
  CreateMcpServerDocument,
  DeleteMcpServerDocument,
  McpProbeDocument,
  McpServersDocument,
  SetMcpServerSecretDocument,
  TestMcpServerDocument,
  UpdateMcpServerDocument,
} from '@/lib/graphql';
import { McpServerManager } from '../mcp-server-manager';

// Ids are minted on the client; pinning them is what lets the mock name the
// exact create the dialog sends.
vi.mock('@/lib/ids', () => ({ newId: () => 'id-1' }));

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
  hasApiKey: false,
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
      <McpServerManager />
    </MockedProvider>,
  );
}

describe('McpServerManager', () => {
  it('lists the servers, with who uses each and what its last test found', async () => {
    const memory = {
      ...SERVER,
      id: 's2',
      slug: 'memory',
      name: 'Memory',
      checkedAt: '2026-09-01T10:00:00.000Z',
      checkOk: true,
      tools: [{ name: 'recall', description: '' }],
      headerNames: ['Authorization'],
    };
    const broken = {
      ...SERVER,
      id: 's3',
      slug: 'old',
      name: 'Old',
      enabled: false,
      checkedAt: '2026-09-01T10:00:00.000Z',
      checkOk: false,
      checkError: 'connect ECONNREFUSED',
    };
    manager([
      servers([SERVER, memory, broken]),
      agents([AGENT, { ...AGENT, id: 'a2', name: 'Writer', mcpServerSlugs: ['memory'] }]),
    ]);

    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(await within(rows[0]).findByText('Used by Reviewer.')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Never tested.')).toBeInTheDocument();
    expect(within(rows[0]).getByText('No secrets')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Used by Reviewer, Writer.')).toBeInTheDocument();
    expect(within(rows[1]).getByText(/^Reached\. 1 tool: recall/)).toBeInTheDocument();
    expect(within(rows[1]).getByText('1 secret set')).toBeInTheDocument();
    expect(within(rows[2]).getByText('Switched off: no agent reaches it.')).toBeInTheDocument();
    expect(within(rows[2]).getByRole('alert')).toHaveTextContent(/Failed .*connect ECONNREFUSED/);
  });

  it('creates a server with what was typed', async () => {
    const user = userEvent.setup();
    const values = {
      id: 'id-1',
      slug: 'files',
      name: 'Files',
      url: null,
      command: 'npx',
      args: ['-y', 'files-mcp'],
      hiddenTools: ['recall'],
      hooks: [{ id: 'memory', on: 'beforeTurn', tool: 'recall' }],
    };
    const create = vi.fn(() => ({ data: { createMcpServer: { ...SERVER, ...values } } }));
    manager([
      servers([]),
      agents([]),
      { request: { query: CreateMcpServerDocument, variables: { values } }, result: create },
      servers([{ ...SERVER, ...values }]),
    ]);

    expect(await screen.findByText('No servers yet.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New server' }));
    await user.type(screen.getByLabelText('Name'), 'Files');
    await user.type(screen.getByLabelText('Slug'), 'files');
    await user.type(screen.getByLabelText('Or a command (stdio)'), 'npx');
    await user.type(screen.getByLabelText('Arguments'), '-y\nfiles-mcp');
    await user.type(screen.getByLabelText('Hidden tools'), 'recall');
    await user.click(screen.getByLabelText('Hooks'));
    await user.paste(JSON.stringify(values.hooks));
    await user.click(screen.getByRole('button', { name: 'Create server' }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('will not save a slug another server has, telos’s own, or a server with nowhere to reach', async () => {
    const user = userEvent.setup();
    manager([servers([SERVER]), agents([])]);

    await user.click(await screen.findByRole('button', { name: 'New server' }));
    await user.type(screen.getByLabelText('Slug'), 'docs');
    expect(await screen.findByText('Another of your servers has that slug.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Slug'));
    await user.type(screen.getByLabelText('Slug'), 'telos');
    expect(await screen.findByText(/telos’s own/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Slug'));
    await user.type(screen.getByLabelText('Slug'), 'files');
    await user.click(screen.getByRole('button', { name: 'Create server' }));

    expect(await screen.findByText('A server needs a URL or a command.')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('switches a server off, and says when that failed', async () => {
    const user = userEvent.setup();
    manager([
      servers([SERVER]),
      agents([AGENT]),
      {
        request: { query: UpdateMcpServerDocument, variables: { id: 's1', set: { enabled: false } } },
        result: { data: { updateMcpServer: { ...SERVER, enabled: false } } },
      },
      {
        request: { query: UpdateMcpServerDocument, variables: { id: 's1', set: { enabled: true } } },
        result: { errors: [new GraphQLError('The database is away.')] },
      },
    ]);

    await user.click(await screen.findByRole('switch', { name: 'Docs on' }));
    expect(await screen.findByText('Switched off: no agent reaches it.')).toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: 'Docs on' }));
    expect(await screen.findByText('The database is away.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Docs on' })).not.toBeChecked());
  });

  it('sets and removes secrets by name, never showing a value', async () => {
    const user = userEvent.setup();
    const set = vi.fn(() => ({
      data: { setMcpServerSecret: { __typename: 'McpServer', id: 's1', headerNames: ['Authorization'], envNames: [] } },
    }));
    const remove = vi.fn(() => ({
      data: { setMcpServerSecret: { __typename: 'McpServer', id: 's1', headerNames: [], envNames: [] } },
    }));
    manager([
      servers([SERVER]),
      agents([]),
      {
        request: {
          query: SetMcpServerSecretDocument,
          variables: { id: 's1', kind: 'header', name: 'Authorization', value: 'Bearer abc' },
        },
        result: set,
      },
      {
        request: {
          query: SetMcpServerSecretDocument,
          variables: { id: 's1', kind: 'header', name: 'Authorization', value: null },
        },
        result: remove,
      },
    ]);

    await user.click(await screen.findByRole('button', { name: 'Secrets' }));
    expect(screen.getByText('None set.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Name'), 'Authorization');
    await user.type(screen.getByLabelText('Value'), 'Bearer abc');
    await user.click(screen.getByRole('button', { name: 'Set secret' }));

    await waitFor(() => expect(set).toHaveBeenCalled());
    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByText('Authorization')).toBeInTheDocument();
    expect(within(dialog).queryByText('Bearer abc')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Value')).toHaveValue('');

    await user.click(within(dialog).getByRole('button', { name: 'Remove Authorization' }));
    await waitFor(() => expect(remove).toHaveBeenCalled());
    expect(await within(dialog).findByText('None set.')).toBeInTheDocument();
  });

  it('tests a saved server through the runner and lists its tools, or says why not', async () => {
    const user = userEvent.setup();
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
      servers([SERVER]),
      agents([]),
      {
        request: { query: TestMcpServerDocument, variables: { id: 's1' } },
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
      servers([SERVER]),
      {
        request: { query: TestMcpServerDocument, variables: { id: 's1' } },
        result: { data: { testMcpServer: { __typename: 'McpProbe', id: 'p2' } } },
      },
      {
        request: { query: McpProbeDocument, variables: { id: 'p2' } },
        result: { data: { mcpProbe: probe({ id: 'p2', ok: false, error: 'connect ECONNREFUSED' }) } },
      },
      servers([SERVER]),
    ]);

    await user.click(await screen.findByRole('button', { name: 'Test Docs' }));
    expect(await screen.findByText('Reached. 2 tools: search, fetch')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Test Docs' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Test Docs' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('connect ECONNREFUSED');
  });

  it('deletes a server once asked twice', async () => {
    const user = userEvent.setup();
    const drop = vi.fn(() => ({ data: { deleteMcpServer: { __typename: 'McpServer', id: 's1' } } }));
    manager([
      servers([SERVER]),
      agents([]),
      { request: { query: DeleteMcpServerDocument, variables: { id: 's1' } }, result: drop },
      servers([]),
    ]);

    await user.click(await screen.findByRole('button', { name: 'Delete Docs' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(drop).toHaveBeenCalled());
    expect(await screen.findByText('No servers yet.')).toBeInTheDocument();
  });
});
