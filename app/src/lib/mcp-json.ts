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
// telos's: the slug rule an account's servers keep, and headers and env split
// off as secrets, which no create mutation carries.

/** A header or environment variable a pasted server comes with, set once the row exists. */
export interface McpServerSecret {
  kind: McpSecretKind;
  name: string;
  value: string;
}

/** One server found in a paste. */
export interface PastedServer {
  /** Its key in the paste, which becomes its slug. */
  key: string;
  /** Whether the runner would start it as a process, rather than reach a URL. */
  stdio: boolean;
  /** What the create sends: everything but the secrets. */
  values: Omit<CreateMcpServerInput, 'id'>;
  /** Its headers or env, for `setMcpServerSecret` after the create. */
  secrets: McpServerSecret[];
  /** Why it cannot be added. Empty means it can. */
  errors: string[];
  /** What it would be added without: a secret whose value is still a `${VAR}` placeholder. */
  warnings: string[];
}

/** What a paste holds. */
export interface PastedServers {
  servers: PastedServer[];
  /** Why the paste as a whole could not be read; with it, `servers` is empty. */
  error: string | null;
}

export interface ReadMcpJsonOptions {
  /** The slugs the account's servers already have. */
  taken: string[];
  /**
   * Whether a command the runner would spawn may be added. Off, a stdio server
   * is listed with the reason it is not offered, so adding one is a choice made
   * on purpose rather than a side effect of pasting a whole file.
   */
  allowStdio: boolean;
}

const PLACEHOLDER = /\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}/;
const NAMESPACE_ERROR = 'cannot namespace tool names';

/** Said on a stdio server while commands are not allowed. */
export const STDIO_REFUSED = 'Starts a command on the runner’s host. Allow commands to add it.';

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
 * @param options - The account's slugs, and whether commands may be added.
 * @returns The servers in the order the paste lists them, or why none could be read.
 */
export function readMcpJson(text: string, { taken, allowStdio }: ReadMcpJsonOptions): PastedServers {
  if (text.trim() === '') return { servers: [], error: null };
  let rows: McpServerConfig[];
  try {
    rows = fromMcpServersJson(text, { env: {} });
  } catch (cause) {
    return { servers: [], error: cause instanceof Error ? cause.message : String(cause) };
  }
  const setErrors = listErrors(rows);
  return { servers: rows.map((row) => toPasted(row, taken, allowStdio, setErrors.get(row.id) ?? [])), error: null };
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

function toPasted(row: McpServerConfig, taken: string[], allowStdio: boolean, setErrors: string[]): PastedServer {
  const slugError = slugRule(taken)({ value: row.id });
  const own = validateServerConfig(row).filter((error) => !(slugError && error.includes(NAMESPACE_ERROR)));
  const errors = [...(slugError ? [slugError] : []), ...own, ...setErrors];
  const stdio = row.transport === 'stdio';
  if (stdio && !allowStdio) errors.push(STDIO_REFUSED);

  const pairs: [McpSecretKind, Record<string, string> | null | undefined][] = stdio
    ? [[McpSecretKind.Env, row.env]]
    : [[McpSecretKind.Header, row.transport === 'http' ? row.headers : null]];
  const secrets: McpServerSecret[] = [];
  const warnings: string[] = [];
  for (const [kind, record] of pairs) {
    for (const [name, value] of Object.entries(record ?? {})) {
      if (typeof value === 'string' && PLACEHOLDER.test(value)) {
        warnings.push(`${name} is still ${value}: set it under Secrets once it is added.`);
      } else if (typeof value === 'string') {
        secrets.push({ kind, name, value });
      }
    }
  }

  return { key: row.id, stdio, values: toValues(row), secrets, errors, warnings };
}

/** The create's values for a pool row: its connection, and the defaults for what a paste cannot say. */
function toValues(row: McpServerConfig): Omit<CreateMcpServerInput, 'id'> {
  const stdio = row.transport === 'stdio';
  return {
    slug: row.id,
    name: row.label || row.id,
    enabled: row.enabled,
    url: stdio ? null : row.url,
    command: stdio ? row.command : null,
    args: stdio ? (row.args ?? []) : [],
    cwd: stdio ? (row.cwd ?? null) : null,
    connectTimeoutMs: null,
    callTimeoutMs: null,
    idleTimeoutMs: null,
    hiddenTools: [],
    hooks: [],
  };
}
