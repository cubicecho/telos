import type { AgentFieldsFragment, CreateAgentInput } from '@/__generated__/graphql';
import { newId } from '@/lib/ids';

// An agent as its form holds it, and back. Numbers are typed as text and read
// on the way out, so a cleared box means "use the runner's default" (null)
// rather than zero; MCP servers are rows of text, with anything the form does
// not edit (headers, env) carried through untouched.

/** One MCP server as its row in the form holds it. */
export interface McpServerDraft {
  id: string;
  name: string;
  url: string;
  command: string;
  /** One argument per line, since an argument may itself contain spaces. */
  args: string;
  /** `headers` and `env`, kept as they came so a save does not drop them. */
  kept: unknown;
}

export interface AgentDraft {
  name: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  temperature: string;
  maxTokens: string;
  contextLength: string;
  maxToolIterations: string;
  toolDiscovery: boolean;
  toolSelectModel: string;
  requestTimeoutSeconds: string;
  maxRetries: string;
  mcpServers: McpServerDraft[];
}

type StoredServer = {
  id?: unknown;
  name?: unknown;
  url?: unknown;
  command?: unknown;
  args?: unknown;
  headers?: unknown;
  env?: unknown;
};

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const numberText = (value: number | null | undefined) => (value == null ? '' : String(value));

export function emptyMcpServer(): McpServerDraft {
  return { id: newId(), name: '', url: '', command: '', args: '', kept: {} };
}

export function toAgentDraft(agent: AgentFieldsFragment | null | undefined): AgentDraft {
  const servers = Array.isArray(agent?.mcpServers) ? (agent.mcpServers as StoredServer[]) : [];
  return {
    name: agent?.name ?? '',
    baseUrl: agent?.baseUrl ?? '',
    model: agent?.model ?? '',
    systemPrompt: agent?.systemPrompt ?? '',
    temperature: numberText(agent?.temperature),
    maxTokens: numberText(agent?.maxTokens),
    contextLength: numberText(agent?.contextLength),
    maxToolIterations: numberText(agent?.maxToolIterations ?? 20),
    toolDiscovery: agent?.toolDiscovery ?? false,
    toolSelectModel: agent?.toolSelectModel ?? '',
    requestTimeoutSeconds: numberText(agent?.requestTimeoutSeconds),
    maxRetries: numberText(agent?.maxRetries),
    mcpServers: servers.map((server) => ({
      id: text(server.id) || newId(),
      name: text(server.name),
      url: text(server.url),
      command: text(server.command),
      args: Array.isArray(server.args) ? server.args.filter((arg) => typeof arg === 'string').join('\n') : '',
      kept: {
        ...(server.headers ? { headers: server.headers } : {}),
        ...(server.env ? { env: server.env } : {}),
      },
    })),
  };
}

const orNull = (value: string) => (value.trim() === '' ? null : value.trim());
const numberOrNull = (value: string) => (value.trim() === '' ? null : Number(value));

/** What a create or an update sends. Every column is stated, so an edit can clear one. */
export function fromAgentDraft(draft: AgentDraft): Omit<CreateAgentInput, 'id'> {
  return {
    name: draft.name.trim(),
    baseUrl: draft.baseUrl.trim(),
    model: draft.model.trim(),
    systemPrompt: orNull(draft.systemPrompt),
    temperature: numberOrNull(draft.temperature),
    maxTokens: numberOrNull(draft.maxTokens),
    contextLength: numberOrNull(draft.contextLength),
    maxToolIterations: Number(draft.maxToolIterations),
    toolDiscovery: draft.toolDiscovery,
    toolSelectModel: orNull(draft.toolSelectModel),
    requestTimeoutSeconds: numberOrNull(draft.requestTimeoutSeconds),
    maxRetries: numberOrNull(draft.maxRetries),
    // A row with neither a URL nor a command is one somebody added and left
    // blank; the runner could do nothing with it.
    mcpServers: draft.mcpServers
      .filter((server) => server.url.trim() !== '' || server.command.trim() !== '')
      .map((server) => {
        const args = server.args
          .split('\n')
          .map((arg) => arg.trim())
          .filter(Boolean);
        return {
          ...(server.kept as object),
          id: server.id,
          ...(server.name.trim() ? { name: server.name.trim() } : {}),
          ...(server.url.trim() ? { url: server.url.trim() } : {}),
          ...(server.command.trim() ? { command: server.command.trim() } : {}),
          ...(args.length > 0 ? { args } : {}),
        };
      }),
  };
}

/**
 * A validator for a number typed as text: blank is fine unless `required`,
 * anything else must be a number, whole when `integer`, and at least `min`.
 */
export function numberRule({
  min,
  integer = true,
  required = false,
}: {
  min: number;
  integer?: boolean;
  required?: boolean;
}) {
  return ({ value }: { value: string }): string | undefined => {
    if (value.trim() === '') return required ? 'Required.' : undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 'Must be a number.';
    if (integer && !Number.isInteger(parsed)) return 'Must be a whole number.';
    if (parsed < min) return `Must be at least ${min}.`;
    return undefined;
  };
}
