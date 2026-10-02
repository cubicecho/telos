import type { AgentFieldsFragment, CreateAgentInput } from '@/__generated__/graphql';

// An agent as its form holds it, and back. Numbers are typed as text and read
// on the way out, so a cleared box means "use the runner's default" (null)
// rather than zero.

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
  /**
   * The slugs of the account's MCP servers it may reach: null is every one,
   * whatever is added later; a list is exactly those, and an empty one is none.
   */
  mcpServerSlugs: string[] | null;
}

const numberText = (value: number | null | undefined) => (value == null ? '' : String(value));

/**
 * An agent's list of servers as it was stored.
 *
 * @param stored - `mcpServerSlugs`, which the API types as JSON.
 * @returns The slugs, or null when the agent reaches every server.
 */
export function readServerSlugs(stored: unknown): string[] | null {
  return Array.isArray(stored) ? stored.filter((slug): slug is string => typeof slug === 'string') : null;
}

export function toAgentDraft(agent: AgentFieldsFragment | null | undefined): AgentDraft {
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
    mcpServerSlugs: readServerSlugs(agent?.mcpServerSlugs),
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
    mcpServerSlugs: draft.mcpServerSlugs,
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
