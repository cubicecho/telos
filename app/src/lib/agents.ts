import type {
  AgentDefaultsInput,
  AgentFieldsFragment,
  CreateAgentInput,
  ResolvedAgentSettingsFieldsFragment,
} from '@/__generated__/graphql';

// An agent as its form holds it, and back, and the account's defaults the same
// way. Every setting is typed as text and read on the way out, so a cleared box
// is null: "inherit", from the defaults for an agent and from agent-core's own
// for the defaults. Zero and an empty model are never what a blank means.

/** Tool discovery, which can be inherited as well as on or off. */
export type Discovery = 'inherit' | 'on' | 'off';

/** The settings an agent and the account's defaults share. */
export interface LayerDraft {
  baseUrl: string;
  model: string;
  temperature: string;
  maxTokens: string;
  contextLength: string;
  maxToolIterations: string;
  toolDiscovery: Discovery;
  toolSelectModel: string;
  requestTimeoutSeconds: string;
  maxRetries: string;
}

export interface AgentDraft extends LayerDraft {
  name: string;
  systemPrompt: string;
  /** Off, it takes no runs and no drafts. */
  enabled: boolean;
  /**
   * The slugs of the account's MCP servers it may reach: null is every one,
   * whatever is added later; a list is exactly those, and an empty one is none.
   */
  mcpServerSlugs: string[] | null;
  /**
   * The MCP door's tools switched off for its runs: null is the run default
   * (reading, adding work and notes), whatever the door adds later; a list is
   * exactly those off, and an empty one is every tool a run may have.
   */
  toolsOff: string[] | null;
}

/** What a layer of settings is, stored. */
export type StoredLayer = { [K in keyof AgentDefaultsInput]?: AgentDefaultsInput[K] };

/** What a blank resolves to: the defaults' `resolved`, or their `builtIn`. */
export type Inherited = ResolvedAgentSettingsFieldsFragment;

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

/**
 * A stored layer as its form holds it.
 *
 * @param layer - The agent's or the defaults' row, or nothing for a new one.
 * @returns The draft.
 */
export function toLayerDraft(layer: StoredLayer | null | undefined): LayerDraft {
  const discovery = layer?.toolDiscovery;
  return {
    baseUrl: layer?.baseUrl ?? '',
    model: layer?.model ?? '',
    temperature: numberText(layer?.temperature),
    maxTokens: numberText(layer?.maxTokens),
    contextLength: numberText(layer?.contextLength),
    maxToolIterations: numberText(layer?.maxToolIterations),
    toolDiscovery: discovery == null ? 'inherit' : discovery ? 'on' : 'off',
    toolSelectModel: layer?.toolSelectModel ?? '',
    requestTimeoutSeconds: numberText(layer?.requestTimeoutSeconds),
    maxRetries: numberText(layer?.maxRetries),
  };
}

export function toAgentDraft(agent: AgentFieldsFragment | null | undefined): AgentDraft {
  return {
    name: agent?.name ?? '',
    systemPrompt: agent?.systemPrompt ?? '',
    enabled: agent?.enabled ?? true,
    ...toLayerDraft(agent),
    mcpServerSlugs: readServerSlugs(agent?.mcpServerSlugs),
    // The same shape as the slugs: a list of names, or null for the default.
    toolsOff: readServerSlugs(agent?.toolsOff),
  };
}

const orNull = (value: string) => (value.trim() === '' ? null : value.trim());
const numberOrNull = (value: string) => (value.trim() === '' ? null : Number(value));

/** A layer's draft as what is stored: every field stated, blank as null. */
export function fromLayerDraft(draft: LayerDraft): Required<StoredLayer> {
  return {
    baseUrl: orNull(draft.baseUrl),
    model: orNull(draft.model),
    temperature: numberOrNull(draft.temperature),
    maxTokens: numberOrNull(draft.maxTokens),
    contextLength: numberOrNull(draft.contextLength),
    maxToolIterations: numberOrNull(draft.maxToolIterations),
    toolDiscovery: draft.toolDiscovery === 'inherit' ? null : draft.toolDiscovery === 'on',
    toolSelectModel: orNull(draft.toolSelectModel),
    requestTimeoutSeconds: numberOrNull(draft.requestTimeoutSeconds),
    maxRetries: numberOrNull(draft.maxRetries),
  };
}

/** What a create or an update sends. Every column is stated, so an edit can clear one. */
export function fromAgentDraft(draft: AgentDraft): Omit<CreateAgentInput, 'id'> {
  return {
    name: draft.name.trim(),
    systemPrompt: orNull(draft.systemPrompt),
    enabled: draft.enabled,
    ...fromLayerDraft(draft),
    mcpServerSlugs: draft.mcpServerSlugs,
    toolsOff: draft.toolsOff,
  };
}

/** Placeholders for a layer's blank fields: what each would be. */
export type LayerHints = Record<Exclude<keyof LayerDraft, 'toolDiscovery'>, string> & { toolDiscovery: string };

/**
 * What each blank field of a layer stands for, as placeholder text.
 *
 * @param inherited - What a blank resolves to, or nothing while it loads.
 * @param from - Whose values they are, for the endpoint and model when there are none.
 * @returns One line per field.
 */
export function layerHints(inherited: Inherited | null | undefined, from: 'defaults' | 'built-in'): LayerHints {
  if (!inherited) {
    return {
      baseUrl: '',
      model: '',
      temperature: '',
      maxTokens: '',
      contextLength: '',
      maxToolIterations: '',
      toolDiscovery: '',
      toolSelectModel: '',
      requestTimeoutSeconds: '',
      maxRetries: '',
    };
  }
  const none = from === 'defaults' ? 'None: no default is set' : 'None';
  // Zero is a value, and for these two it says "leave it to the endpoint".
  const orEndpoint = (value: number, zero: string) => (value === 0 ? zero : String(value));
  return {
    baseUrl: inherited.baseUrl || none,
    model: inherited.model || none,
    temperature: String(inherited.temperature),
    maxTokens: orEndpoint(inherited.maxTokens, 'No limit'),
    contextLength: orEndpoint(inherited.contextLength, 'Ask the endpoint'),
    maxToolIterations: String(inherited.maxToolIterations),
    toolDiscovery: inherited.toolDiscovery ? 'on' : 'off',
    toolSelectModel: inherited.toolSelectModel || 'None',
    requestTimeoutSeconds: numberText(inherited.requestTimeoutSeconds) || 'No limit',
    maxRetries: String(inherited.maxRetries),
  };
}

/**
 * What an agent would run without, with its own fields over what it inherits.
 *
 * @param own - The endpoint and model typed for the agent.
 * @param inherited - What a blank resolves to, or nothing while it loads.
 * @returns A warning, or null when it has both or the defaults are not in yet.
 */
export function missingSetup(own: { baseUrl: string; model: string }, inherited: Inherited | null | undefined) {
  if (!inherited) return null;
  const missing = [
    own.baseUrl.trim() || inherited.baseUrl ? null : 'endpoint',
    own.model.trim() || inherited.model ? null : 'model',
  ].filter(Boolean);
  if (missing.length === 0) return null;
  return `No ${missing.join(' and no ')}: give it one here, or set one in Agent defaults. Until then it cannot run.`;
}

/**
 * A validator for a number typed as text: blank is fine unless `required`,
 * anything else must be a number, whole when `integer`, at least `min` and at
 * most `max`.
 */
export function numberRule({
  min,
  max,
  integer = true,
  required = false,
}: {
  min: number;
  max?: number;
  integer?: boolean;
  required?: boolean;
}) {
  return ({ value }: { value: string }): string | undefined => {
    if (value.trim() === '') return required ? 'Required.' : undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 'Must be a number.';
    if (integer && !Number.isInteger(parsed)) return 'Must be a whole number.';
    if (parsed < min) return `Must be at least ${min}.`;
    if (max !== undefined && parsed > max) return `Must be at most ${max}.`;
    return undefined;
  };
}
