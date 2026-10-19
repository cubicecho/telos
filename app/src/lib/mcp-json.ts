import {
  fromMcpServersJson,
  type McpServerConfig,
  validateServerConfig,
  validateServers,
} from '@cubicecho/agent-mcp-pool/servers';
import { type CreateMcpServerInput, McpSecretKind } from '@/__generated__/graphql';
import { slugRule } from '@/lib/mcp-servers';

// A pasted `.mcp.json` as rows to create. The reading and the checking are the
// pool's (`fromMcpServersJson`, `validateServerConfig`, `validateServers`), the
// same code the runner connects with. This file only maps those rows onto
// telos's: the slug rule an account's servers keep, headers split off as
// secrets, which no create mutation carries, and stdio servers listed as what
// telos does not run.

/** A header a pasted server comes with, set once the row exists. */
export interface McpServerSecret {
  kind: McpSecretKind;
  name: string;
  value: string;
}

/** What a create of a pasted server sends. */
type PastedValues = Omit<CreateMcpServerInput, 'id'>;

/** One server found in a paste. */
export interface PastedServer {
  /** Its key in the paste, which becomes its slug. */
  key: string;
  /** Whether it is a command to start (stdio), which telos does not run. */
  stdio: boolean;
  /** What it reaches: its URL, or for a stdio server the command line it gives. */
  target: string;
  /** What the create sends: everything but the secrets. Null for a stdio server, which is never created. */
  values: PastedValues | null;
  /** Its headers, for `setMcpServerSecret` after the create. */
  secrets: McpServerSecret[];
  /** Why it cannot be added. Empty means it can. */
  errors: string[];
  /** What it would be added without: a secret whose value is still a `${VAR}` placeholder. */
  warnings: string[];
}

/** A pasted server that can be added: no errors, and so values to create. */
export type AddableServer = PastedServer & { values: PastedValues };

/** What a paste holds. */
export interface PastedServers {
  servers: PastedServer[];
  /** Why the paste as a whole could not be read; with it, `servers` is empty. */
  error: string | null;
}

export interface ReadMcpJsonOptions {
  /** The slugs the account's servers already have. */
  taken: string[];
}

const PLACEHOLDER = /\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}/;
const NAMESPACE_ERROR = 'cannot namespace tool names';

/** Said on a stdio server, which is listed so that a paste of a whole file says what it left out. */
export const STDIO_UNSUPPORTED =
  'Not supported: this is a command (stdio) server, and telos only reaches MCP servers at a URL. Use its HTTP endpoint, if it has one.';

/**
 * The servers a pasted `mcpServers` block describes, checked against the
 * account's and ready to create.
 *
 * Placeholders (`${VAR}`) are not filled from anything: the browser has no
 * environment worth reading, and what the app was built with is not the
 * runner's. A secret that is still one is left out and said, so it can be set
 * by hand rather than stored as the literal text.
 *
 * @param text - What was pasted.
 * @param options - The account's slugs.
 * @returns The servers in the order the paste lists them, or why none could be read.
 */
export function readMcpJson(text: string, { taken }: ReadMcpJsonOptions): PastedServers {
  if (text.trim() === '') return { servers: [], error: null };
  let rows: McpServerConfig[];
  try {
    rows = fromMcpServersJson(text, { env: {} });
  } catch (cause) {
    return { servers: [], error: cause instanceof Error ? cause.message : String(cause) };
  }
  const setErrors = listErrors(rows);
  return { servers: rows.map((row) => toPasted(row, taken, setErrors.get(row.id) ?? [])), error: null };
}

/**
 * Whether a pasted server can be added: it has no errors, and so values to create.
 *
 * @param server - One server from `readMcpJson`.
 * @returns Whether it can.
 */
export function isAddable(server: PastedServer): server is AddableServer {
  return server.errors.length === 0 && server.values !== null;
}

/**
 * The problems `validateServers` finds across the paste, by row: two rows that
 * would share an id or a namespace. Its per-row messages are dropped here,
 * since each row's own come from `validateServerConfig` unprefixed.
 */
function listErrors(rows: McpServerConfig[]): Map<string, string[]> {
  const own = new Set(rows.flatMap((row) => validateServerConfig(row).map((error) => `server "${row.id}": ${error}`)));
  const byRow = new Map<string, string[]>();
  for (const error of validateServers(rows)) {
    if (own.has(error)) continue;
    for (const row of rows) {
      if (error.includes(`"${row.id}"`)) byRow.set(row.id, [...(byRow.get(row.id) ?? []), error]);
    }
  }
  return byRow;
}

function toPasted(row: McpServerConfig, taken: string[], setErrors: string[]): PastedServer {
  if (row.transport === 'stdio') {
    // Nothing else about it matters: no fix to it would make it one telos runs.
    const target = [row.command, ...(row.args ?? [])].join(' ').trim();
    return { key: row.id, stdio: true, target, values: null, secrets: [], errors: [STDIO_UNSUPPORTED], warnings: [] };
  }
  const slugError = slugRule(taken)({ value: row.id });
  const own = validateServerConfig(row).filter((error) => !(slugError && error.includes(NAMESPACE_ERROR)));
  const errors = [...(slugError ? [slugError] : []), ...own, ...setErrors];

  const secrets: McpServerSecret[] = [];
  const warnings: string[] = [];
  for (const [name, value] of Object.entries(row.headers ?? {})) {
    if (typeof value === 'string' && PLACEHOLDER.test(value)) {
      warnings.push(`${name} is still ${value}: set it under Secrets once it is added.`);
    } else if (typeof value === 'string') {
      secrets.push({ kind: McpSecretKind.Header, name, value });
    }
  }

  return { key: row.id, stdio: false, target: row.url, values: toValues(row), secrets, errors, warnings };
}

/** The create's values for a pool row: its URL, and the defaults for what a paste cannot say. */
function toValues(row: Extract<McpServerConfig, { transport: 'http' }>): PastedValues {
  return {
    slug: row.id,
    name: row.label || row.id,
    enabled: row.enabled,
    url: row.url,
    connectTimeoutMs: null,
    callTimeoutMs: null,
    idleTimeoutMs: null,
    hiddenTools: [],
    hooks: [],
  };
}
