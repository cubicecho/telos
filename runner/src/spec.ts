import {
  type AgentSpec,
  defineSpecColumns,
  NO_KEY,
  parseSpec,
  type ResolvedAgent,
  resolveAgentSpec,
  resolveApiKey,
} from '@cubicecho/agent-core';

// An agent as layered documents: the account's defaults under the agent, read
// with agent-core's spec rules. Absent inherits and nothing else does, so a
// stored `temperature: 0` is a temperature of zero and only a null passes the
// question down. What no layer says is agent-core's `RESOLVED_DEFAULTS`.
//
// The server reads this too (`@telos/runner/spec`), so what Settings says an
// agent will inherit and what a run is given are worked out by the same code.

/** One layer as telos stores it: an agent's row, or the account's defaults. Null says nothing. */
export interface AgentLayer {
  baseUrl?: string | null;
  model?: string | null;
  temperature?: number | null;
  maxTokens?: number | null;
  contextLength?: number | null;
  maxToolIterations?: number | null;
  /** On is agent-core's `ondemand` discovery, off its `eager`. */
  toolDiscovery?: boolean | null;
  toolSelectModel?: string | null;
  /** A level, or "off" for none, which an agent can say over a default's level. */
  reasoningEffort?: string | null;
  /** agent-core's `reasoningReplay`: "all", "tool-loop" or "none". */
  reasoningReplay?: string | null;
  requestTimeoutSeconds?: number | null;
  maxRetries?: number | null;
}

/** A layer with its key, which no spec carries and `resolveApiKey` applies afterwards. */
export interface KeyedLayer extends AgentLayer {
  apiKey?: string | null;
}

/** What an agent resolves to, and what the documents said along the way. */
export interface ResolvedRunAgent {
  /** What `runAgentLoop` takes, key included. */
  config: ResolvedAgent;
  /** Values the spec would not take, dropped: one line each, for the run to show. */
  warnings: string[];
}

/**
 * Which column feeds which spec field. A null is absent, which is the only
 * "inherit" a layer stores, so no column needs a marker of its own.
 */
const COLUMNS = defineSpecColumns<AgentLayer>({
  baseUrl: { path: 'endpoint.baseUrl' },
  requestTimeoutSeconds: { path: 'endpoint.requestTimeoutSeconds' },
  model: { path: 'model.model' },
  maxTokens: { path: 'model.maxTokens' },
  temperature: { path: 'model.temperature' },
  contextLength: { path: 'model.contextLength' },
  reasoningEffort: { path: 'model.reasoningEffort' },
  reasoningReplay: { path: 'model.reasoningReplay' },
  toolDiscovery: { path: 'tools.discovery', toSpec: (on) => (on ? 'ondemand' : 'eager') },
  maxToolIterations: { path: 'tools.maxIterations' },
  maxRetries: { path: 'retry.maxRetries' },
  toolSelectModel: { path: 'tasks.toolSelect.model' },
});

/**
 * A stored layer as an agent spec document, saying only what the row says.
 *
 * @param layer - The row.
 * @returns The document, which `parseSpec` has not yet read.
 */
export function specLayer(layer: AgentLayer): AgentSpec {
  return COLUMNS.toLayer(layer);
}

/**
 * The account's defaults with an agent over them, resolved, and its key chosen.
 *
 * @param defaults - The account's layer, or null where it has set none.
 * @param agent - The agent's own.
 * @returns The flat config, and what was dropped on the way.
 *
 * @remarks
 * The key is the agent's own, else the default key only where the agent
 * inherits the default endpoint: one that names its own base URL is never sent
 * the key entered for another. The environment is not asked, because the
 * runner's environment is the instance's, and its key is nobody's account's.
 */
export function resolveAgent(defaults: KeyedLayer | null, agent: KeyedLayer): ResolvedRunAgent {
  const warnings: string[] = [];
  const layers: AgentSpec[] = [];
  for (const [label, layer] of [
    ['defaults', defaults],
    ['agent', agent],
  ] as const) {
    if (!layer) continue;
    const parsed = parseSpec(specLayer(layer));
    for (const warning of parsed.warnings) warnings.push(`${label}: ${warning}`);
    if (parsed.spec) layers.push(parsed.spec);
  }
  const config = resolveAgentSpec(layers);
  config.apiKey = resolveApiKey(
    { baseUrl: agent.baseUrl ?? undefined, apiKey: agent.apiKey ?? undefined },
    defaults ? { baseUrl: defaults.baseUrl ?? '', apiKey: defaults.apiKey ?? '' } : undefined,
    {},
  );
  return { config, warnings };
}

/**
 * The key to send to one endpoint, by the rule a run's key is chosen by.
 *
 * @param baseUrl - Where the request goes.
 * @param own - The agent's own key, if any.
 * @param defaults - The account's defaults, if any.
 * @returns The key, or null where none is to be sent.
 */
export function keyFor(baseUrl: string, own: string | null, defaults: KeyedLayer | null): string | null {
  const key = resolveApiKey(
    { baseUrl, apiKey: own ?? undefined },
    defaults ? { baseUrl: defaults.baseUrl ?? '', apiKey: defaults.apiKey ?? '' } : undefined,
    {},
  );
  return key === NO_KEY ? null : key;
}

/**
 * Why an agent cannot run as it resolves, or null when it can.
 *
 * @param config - The resolved agent.
 * @param name - What it is called, for the message.
 * @returns The reason.
 */
export function unrunnable(config: Pick<ResolvedAgent, 'baseUrl' | 'model'>, name: string): string | null {
  const missing = [config.baseUrl.trim() ? null : 'endpoint', config.model.trim() ? null : 'model'].filter(Boolean);
  if (missing.length === 0) return null;
  return `${name} has no ${missing.join(' and no ')}: give it one, or set a default in Settings → Agents.`;
}
