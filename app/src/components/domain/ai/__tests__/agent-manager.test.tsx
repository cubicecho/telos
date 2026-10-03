import { MockedProvider } from '@apollo/client/testing';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GraphQLError } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { AGENT_TEMPLATES } from '@/lib/agent-templates';
import {
  AgentDefaultsDocument,
  AgentModelsDocument,
  AgentsDocument,
  CreateAgentDocument,
  McpServersDocument,
  McpToolsDocument,
  SetAgentApiKeyDocument,
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
  reasoningEffort: null,
  requestTimeoutSeconds: null,
  maxRetries: null,
  mcpServerSlugs: null,
  enabled: true,
  toolsOff: null,
  hasApiKey: false,
};

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

/** The account's defaults, `resolved` over agent-core's own. */
function defaults(resolved: Partial<typeof BUILT_IN> = {}) {
  return {
    request: { query: AgentDefaultsDocument },
    result: {
      data: {
        agentDefaults: {
          __typename: 'AgentDefaults',
          id: 'u1',
          baseUrl: resolved.baseUrl || null,
          model: resolved.model || null,
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
          resolved: { ...BUILT_IN, ...resolved },
          builtIn: BUILT_IN,
        },
      },
    },
  };
}

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
  cwd: null,
  connectTimeoutMs: null,
  callTimeoutMs: null,
  idleTimeoutMs: null,
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
function manager(mocks: any[], inherited = defaults()) {
  render(
    <MockedProvider mocks={[inherited, inherited, ...mocks]}>
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
      // Blank inherits: none of these is sent as a value it was not given.
      maxToolIterations: null,
      toolDiscovery: null,
      toolSelectModel: null,
      reasoningEffort: null,
      requestTimeoutSeconds: null,
      maxRetries: null,
      enabled: true,
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

  it('creates an agent from a template, needing only an endpoint and a model', async () => {
    minted = 0;
    const user = userEvent.setup();
    const reviewer = AGENT_TEMPLATES.find((template) => template.id === 'reviewer');
    const values = {
      id: 'id-1',
      name: 'Reviewer',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen3:14b',
      systemPrompt: reviewer?.draft.systemPrompt,
      temperature: 0,
      maxTokens: null,
      contextLength: null,
      maxToolIterations: null,
      toolDiscovery: null,
      toolSelectModel: null,
      reasoningEffort: null,
      requestTimeoutSeconds: null,
      maxRetries: null,
      enabled: true,
      mcpServerSlugs: null,
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
    await user.click(screen.getByRole('button', { name: 'From template' }));
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual([
      'RefinerDrafts',
      'PlannerExpand',
      'WorkerWork',
      'ReviewerVerdict',
    ]);
    await user.click(screen.getByRole('menuitem', { name: /Reviewer/ }));

    expect(await screen.findByRole('heading', { name: 'New Reviewer' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Reviewer');
    expect(screen.getByLabelText('Temperature')).toHaveValue('0');
    await user.type(screen.getByLabelText('Base URL'), 'http://localhost:11434/v1');
    await user.type(screen.getByLabelText('Model'), 'qwen3:14b');
    await user.click(screen.getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(create).toHaveBeenCalled());
  });

  it('starts a Refiner reaching no servers, since a draft has no use for tools', async () => {
    const user = userEvent.setup();
    manager([agents([]), servers([SERVER]), tools]);

    await user.click(await screen.findByRole('button', { name: 'From template' }));
    await user.click(await screen.findByRole('menuitem', { name: /Refiner/ }));

    expect(await screen.findByRole('checkbox', { name: 'Every server' })).not.toBeChecked();
  });

  it('says what a blank field inherits, and warns while it would have no model', async () => {
    const user = userEvent.setup();
    manager([agents([])], defaults({ baseUrl: 'http://llm.local/v1', temperature: 0.2 }));

    await user.click(await screen.findByRole('button', { name: 'New agent' }));
    expect(await screen.findByPlaceholderText('http://llm.local/v1')).toBe(screen.getByLabelText('Base URL'));
    expect(screen.getByLabelText('Temperature')).toHaveAttribute('placeholder', '0.2');
    expect(screen.getByLabelText('Max tokens')).toHaveAttribute('placeholder', 'No limit');
    expect(screen.getByText(/^No model: give it one here/)).toBeInTheDocument();

    await user.type(screen.getByLabelText('Model'), 'qwen3:14b');
    expect(screen.queryByText(/^No model/)).not.toBeInTheDocument();
  });

  it('shows an agent that is switched off, and what its blanks inherit', async () => {
    manager(
      [agents([{ ...AGENT, enabled: false, model: null }])],
      defaults({ baseUrl: 'http://llm.local/v1', model: 'big' }),
    );

    expect(await screen.findByText('Off')).toBeInTheDocument();
    expect(await screen.findByText('big (default) · http://localhost:11434/v1')).toBeInTheDocument();
  });

  it('lists the endpoint’s models on opening, picks one, and takes its context length', async () => {
    const user = userEvent.setup();
    manager([
      agents([AGENT]),
      {
        request: {
          query: AgentModelsDocument,
          variables: { baseUrl: 'http://localhost:11434/v1', agentId: 'a1', apiKey: null },
        },
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
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('2 models at http://localhost:11434/v1')).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    await user.click(await screen.findByRole('option', { name: /llama3:8b/ }));

    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveTextContent('llama3:8b');
    expect(screen.getByLabelText('Context length')).toHaveValue('8192');
  });

  it('says when the endpoint will not list its models, and lets one be typed', async () => {
    const user = userEvent.setup();
    manager([
      agents([AGENT]),
      {
        request: {
          query: AgentModelsDocument,
          variables: { baseUrl: 'http://localhost:11434/v1', agentId: 'a1', apiKey: null },
        },
        result: { errors: [new GraphQLError('The endpoint did not answer.')] },
      },
    ]);

    await user.click(await screen.findByRole('button', { name: 'Edit Reviewer' }));
    expect(await screen.findByText('Failed')).toBeInTheDocument();
    expect(screen.getByLabelText('Model')).toHaveRole('textbox');
  });

  it('saves a key typed with the agent, and asks the endpoint with it before then', async () => {
    const user = userEvent.setup();
    const setKey = vi.fn(() => ({
      data: { setAgentApiKey: { ...AGENT, hasApiKey: true } },
    }));
    const listed = vi.fn(() => ({ data: { agentModels: [] } }));
    manager([
      agents([AGENT]),
      {
        request: {
          query: AgentModelsDocument,
          variables: { baseUrl: 'http://localhost:11434/v1', agentId: 'a1', apiKey: null },
        },
        result: { data: { agentModels: [] } },
      },
      {
        request: {
          query: AgentModelsDocument,
          variables: { baseUrl: 'http://localhost:11434/v1', agentId: 'a1', apiKey: 'sk-new' },
        },
        result: listed,
      },
      {
        request: { query: UpdateAgentDocument },
        variableMatcher: () => true,
        result: { data: { updateAgent: AGENT } },
      },
      { request: { query: SetAgentApiKeyDocument, variables: { agentId: 'a1', apiKey: 'sk-new' } }, result: setKey },
    ]);

    await user.click(await screen.findByRole('button', { name: 'Edit Reviewer' }));
    await user.type(screen.getByLabelText('API key'), 'sk-new');
    await user.tab();
    await waitFor(() => expect(listed).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(setKey).toHaveBeenCalled());
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
