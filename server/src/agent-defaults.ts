import * as dbSchema from '@telos/db/schema';
import { resolveAgent } from '@telos/runner/spec';
import { eq } from 'drizzle-orm';

// The account's agent defaults: the layer under every agent it has. The runner
// layers them (runner/src/spec.ts); the server only stores them and hands them
// over with a claim, and reads them back resolved for Settings, through the
// same `resolveAgent`, so the form and a run never disagree about a blank.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyDb = any;

/** The settings a defaults row and an agent share, by name. */
export const LAYER_FIELDS = [
  'baseUrl',
  'model',
  'temperature',
  'maxTokens',
  'contextLength',
  'maxToolIterations',
  'toolDiscovery',
  'toolSelectModel',
  'reasoningEffort',
  'requestTimeoutSeconds',
  'maxRetries',
] as const;

/**
 * An account's defaults, key included, or null where it has never set any.
 *
 * @param db - The database or a transaction.
 * @param userId - Whose.
 * @returns The row.
 */
export async function loadAgentDefaults(db: AnyDb, userId: string): Promise<dbSchema.AgentDefaults | null> {
  const [row] = await db.select().from(dbSchema.agentDefaults).where(eq(dbSchema.agentDefaults.userId, userId));
  return row ?? null;
}

/**
 * The model a run of this agent asks for: its own, else the account's.
 *
 * @param defaults - The account's defaults.
 * @param agent - The agent.
 * @returns The model, or null where neither names one.
 */
export function effectiveModel(
  defaults: dbSchema.AgentDefaults | null,
  agent: Pick<dbSchema.Agent, (typeof LAYER_FIELDS)[number]>,
): string | null {
  return resolveAgent(defaults, agent).config.model || null;
}
