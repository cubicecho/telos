import type { CreateMcpServerInput, McpServerFieldsFragment } from '@/__generated__/graphql';

// An MCP server as its form holds it, and back. Lists are typed a line each,
// since an argument may itself contain spaces, and hooks as the JSON the
// runner reads, which it checks: a hook it cannot use is said on the run.

export interface McpServerDraft {
  slug: string;
  name: string;
  url: string;
  command: string;
  /** One argument per line. */
  args: string;
  /** Where a command runs; blank for the runner's own directory. */
  cwd: string;
  /** Seconds, typed; blank for the runner's default. */
  connectTimeout: string;
  callTimeout: string;
  /** Seconds a server may sit unused before it is closed; 0 is never. */
  idleTimeout: string;
  /** One tool name per line. */
  hiddenTools: string;
  /** A JSON list, or blank for none. */
  hooks: string;
}

/** A tool a server offered the last time it was tested. */
export interface McpServerTool {
  name: string;
  description: string;
}

/** What every run already has, so no server may take its name. */
export const TELOS_SLUG = 'telos';
const SLUG = /^[A-Za-z0-9_-]+$/;
const SLUG_CHARS = 60;
const HOOK_INDENT = 2;

const lines = (value: unknown) =>
  Array.isArray(value) ? value.filter((line): line is string => typeof line === 'string').join('\n') : '';

const fromLines = (value: string) =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

const orNull = (value: string) => (value.trim() === '' ? null : value.trim());

const MS_PER_SECOND = 1000;

/** Milliseconds as the seconds the form shows, or blank for none. */
const toSeconds = (ms: number | null | undefined) => (ms == null ? '' : String(ms / MS_PER_SECOND));

/** Seconds as typed, as the milliseconds stored, or null for blank. */
const toMs = (seconds: string) => (seconds.trim() === '' ? null : Math.round(Number(seconds) * MS_PER_SECOND));

/**
 * A server's form, filled from a row or blank for a new one.
 *
 * @param server - The row, or null for a new server.
 * @returns What the form starts with.
 */
export function toServerDraft(server: McpServerFieldsFragment | null): McpServerDraft {
  const hooks = Array.isArray(server?.hooks) && server.hooks.length > 0 ? server.hooks : null;
  return {
    slug: server?.slug ?? '',
    name: server?.name ?? '',
    url: server?.url ?? '',
    command: server?.command ?? '',
    args: lines(server?.args),
    cwd: server?.cwd ?? '',
    connectTimeout: toSeconds(server?.connectTimeoutMs),
    callTimeout: toSeconds(server?.callTimeoutMs),
    idleTimeout: toSeconds(server?.idleTimeoutMs),
    hiddenTools: lines(server?.hiddenTools),
    hooks: hooks ? JSON.stringify(hooks, null, HOOK_INDENT) : '',
  };
}

/**
 * What a create or an update sends. Every column the form edits is stated, so
 * an edit can clear one.
 *
 * @param draft - The form, already checked by `hooksRule` and `slugRule`.
 * @returns The values.
 */
export function fromServerDraft(draft: McpServerDraft): Omit<CreateMcpServerInput, 'id'> {
  return {
    slug: draft.slug.trim(),
    name: draft.name.trim() || draft.slug.trim(),
    url: orNull(draft.url),
    command: orNull(draft.command),
    args: fromLines(draft.args),
    cwd: orNull(draft.cwd),
    connectTimeoutMs: toMs(draft.connectTimeout),
    callTimeoutMs: toMs(draft.callTimeout),
    idleTimeoutMs: toMs(draft.idleTimeout),
    hiddenTools: fromLines(draft.hiddenTools),
    hooks: draft.hooks.trim() === '' ? [] : JSON.parse(draft.hooks),
  };
}

/**
 * A validator for a slug: the name a server's tools go by (`slug__tool`).
 *
 * @param taken - The slugs the account's other servers have.
 * @returns The rule.
 */
export function slugRule(taken: string[]) {
  return ({ value }: { value: string }): string | undefined => {
    const slug = value.trim();
    if (slug === '') return 'A server needs a slug.';
    if (SLUG.test(slug) === false) return 'Letters, digits, - and _ only.';
    if (slug.length > SLUG_CHARS) return `At most ${SLUG_CHARS} characters.`;
    if (slug === TELOS_SLUG) return 'That one is telos’s own, which every run already has.';
    if (taken.includes(slug)) return 'Another of your servers has that slug.';
    return undefined;
  };
}

/**
 * A validator for a time typed in seconds: blank, or a number of them.
 *
 * @param allowZero - Whether 0 means something (an idle server never closed).
 * @returns The rule.
 */
export function secondsRule(allowZero: boolean) {
  return ({ value }: { value: string }): string | undefined => {
    if (value.trim() === '') return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) === false) return 'A number of seconds, or blank for the default.';
    if (allowZero ? seconds < 0 : seconds * MS_PER_SECOND < 1) {
      return allowZero ? '0 or more. 0 keeps it open.' : 'More than 0.';
    }
    return undefined;
  };
}

/** A validator for hooks typed as JSON: blank, or a list. */
export function hooksRule({ value }: { value: string }): string | undefined {
  if (value.trim() === '') return undefined;
  try {
    return Array.isArray(JSON.parse(value)) ? undefined : 'Hooks are a JSON list: [ { … } ].';
  } catch {
    return 'That is not JSON.';
  }
}

/**
 * The tools a server offered when it was last tested.
 *
 * @param stored - `tools`, which the API types as JSON.
 * @returns Them.
 */
export function readTools(stored: unknown): McpServerTool[] {
  if (Array.isArray(stored) === false) return [];
  return (stored as unknown[]).flatMap((tool) => {
    const name = (tool as { name?: unknown } | null)?.name;
    const description = (tool as { description?: unknown } | null)?.description;
    return typeof name === 'string' ? [{ name, description: typeof description === 'string' ? description : '' }] : [];
  });
}
