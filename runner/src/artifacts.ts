import type OpenAI from 'openai';
import { TELOS_SERVER } from './tools.ts';

// Recognising what a run left behind. Pure: nothing here talks to telos, which
// is told once, in the finish.
//
// Three ways in. An agent that says what it made calls `record_artifact`, and
// is believed, title and all, as long as some tool call in the run carried
// that location: a model left alone with only the board will otherwise
// "save" its answer to a file it never wrote. An agent that forgets still
// made the file, so every successful tool call is also read for the shape of
// a write: a verb in the tool's name and a path in its arguments. That half is
// a guess, and is sent as one (`source: 'detected'`). And a note the agent
// adds to its own todo is kept as a link to that note (`telos:note/<id>`), so
// the board can open the thread at it.

export type ArtifactAction = 'created' | 'updated' | 'moved' | 'deleted';

export interface ArtifactDraft {
  location: string;
  source: 'declared' | 'detected';
  action: ArtifactAction;
  /** The slug the tool was reached through, or null when nothing said. */
  serverSlug: string | null;
  tool: string | null;
  title?: string | null;
  description?: string | null;
  mediaType?: string | null;
  sizeBytes?: number | null;
}

export const RECORD_ARTIFACT = 'record_artifact';

export const RECORD_ARTIFACT_DEFINITION: OpenAI.ChatCompletionTool = {
  type: 'function',
  function: {
    name: RECORD_ARTIFACT,
    description:
      'Name something a tool call in this run stored outside the board, so the board lists it: a ' +
      'file one of your tools wrote, a page it published, an object it uploaded. Only for a ' +
      'location a tool was actually given or answered with; one that no tool call in this run ' +
      'touched is refused. Your reply and your notes are already on the todo, so never record ' +
      'them, and never invent a file to put them in. Writes through a filesystem tool are noticed ' +
      'on their own; calling this adds the title and description a person would want.',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'The path or URI, exactly as the tool that stored it was given it.' },
        title: { type: 'string', description: 'A short name for it.' },
        description: { type: 'string', description: 'One sentence on what it is for.' },
        mediaType: { type: 'string', description: 'e.g. text/markdown. Optional.' },
        server: { type: 'string', description: 'The tool prefix it was written through: `fs` for `fs__write_file`.' },
      },
      required: ['location'],
      additionalProperties: false,
    },
  },
};

/** A verb at the front of a tool name that means something was written somewhere. */
const WRITE_VERB = /^(write|create|save|upload|put|append|edit|move|rename|copy|publish|delete|remove)(_|$)/;

/** Writes that leave nothing a person would call an artifact behind. */
const NOT_ARTIFACTS = new Set(['create_directory', 'create_dir', 'create_folder', 'mkdir']);

/** The argument names a location goes by, in the order they are believed. */
const LOCATION_KEYS = [
  'destination',
  'dest',
  'target',
  'path',
  'file_path',
  'filePath',
  'filename',
  'file',
  'uri',
  'url',
  'key',
];

const CONTENT_KEYS = ['content', 'contents', 'text', 'body', 'data'];

/**
 * Splits `<slug>__<tool>`. A slug is a single token, so the first `__` is where it ends.
 *
 * @param name The qualified tool name.
 * @returns The slug (empty when there is none) and the tool.
 */
export function splitToolName(name: string): { serverSlug: string; tool: string } {
  const at = name.indexOf('__');
  return at < 0 ? { serverSlug: '', tool: name } : { serverSlug: name.slice(0, at), tool: name.slice(at + 2) };
}

/**
 * What a successful call wrote, if its name and arguments look like a write.
 *
 * @param name The qualified tool name.
 * @param args The call's arguments.
 * @returns The draft, or null.
 */
export function detectArtifact(name: string, args: Record<string, unknown>): ArtifactDraft | null {
  const { serverSlug, tool } = splitToolName(name);
  // The telos door writes notes and requests, which are the board's own.
  if (serverSlug === TELOS_SERVER) return null;
  const verb = tool.split('__').at(-1)?.toLowerCase() ?? '';
  if (!WRITE_VERB.test(verb) || NOT_ARTIFACTS.has(verb)) return null;

  const location = LOCATION_KEYS.map((key) => args[key]).find(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  );
  if (!location) return null;

  const content = CONTENT_KEYS.map((key) => args[key]).find((value): value is string => typeof value === 'string');
  return {
    location: location.trim(),
    source: 'detected',
    action: /^(edit|append)/.test(verb)
      ? 'updated'
      : /^(move|rename)/.test(verb)
        ? 'moved'
        : /^(delete|remove)/.test(verb)
          ? 'deleted'
          : 'created',
    serverSlug: serverSlug || null,
    tool,
    mediaType: mediaTypeFor(location),
    sizeBytes: content === undefined ? null : Buffer.byteLength(content),
  };
}

/**
 * What the model said through `record_artifact`.
 *
 * @param args The call's arguments.
 * @returns The draft, or null when it named no location.
 */
export function declaredArtifact(args: Record<string, unknown>): ArtifactDraft | null {
  const text = (key: string) => (typeof args[key] === 'string' ? String(args[key]).trim() : '');
  const location = text('location');
  if (!location) return null;
  return {
    location,
    source: 'declared',
    action: 'created',
    serverSlug: text('server') || null,
    tool: null,
    title: text('title') || null,
    description: text('description') || null,
    mediaType: text('mediaType') || mediaTypeFor(location),
  };
}

/** The scheme a note artifact's location starts with: `telos:note/<id>`. */
export const NOTE_LOCATION = 'telos:note/';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The note an `add_todo_note` call left on the run's own todo, as a link to it.
 * A note on some other todo is that todo's business, and is not kept here.
 *
 * @param name The qualified tool name.
 * @param args The call's arguments.
 * @param answer What the tool answered: the new note's id, as JSON.
 * @param todoId The run's todo.
 * @returns The draft, or null.
 */
export function noteArtifact(
  name: string,
  args: Record<string, unknown>,
  answer: string,
  todoId: string,
): ArtifactDraft | null {
  const { serverSlug, tool } = splitToolName(name);
  if (serverSlug !== TELOS_SERVER || tool !== 'add_todo_note' || args.todoId !== todoId) return null;
  const id = /"id"\s*:\s*"([^"]+)"/.exec(answer)?.[1];
  if (!id || !UUID.test(id)) return null;
  const body = typeof args.body === 'string' ? args.body : '';
  const title = body
    .split('\n')
    .map((line) => line.replace(/^[#>*\-\s]+/, '').trim())
    .find(Boolean);
  return {
    location: `${NOTE_LOCATION}${id}`,
    source: 'detected',
    action: 'created',
    serverSlug,
    tool,
    title: title ? title.slice(0, 120) : null,
    mediaType: 'text/markdown',
    sizeBytes: Buffer.byteLength(body),
  };
}

/** A location as it is compared: no scheme, no leading slashes, no trailing ones. */
function bare(location: string): string {
  return location
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^\/+|\/+$/g, '');
}

/**
 * A run's artifacts, one per location. A declaration fills in what a detection
 * could not know, and a later action on the same location is the one kept.
 */
export class ArtifactLog {
  readonly #byLocation = new Map<string, ArtifactDraft>();
  /** Everything the run's tool calls were given and answered, to check a declaration against. */
  readonly #witnessed: string[] = [];

  /**
   * Keeps what a tool call was given and answered, so a declaration naming it
   * is believed.
   *
   * @param args The call's arguments.
   * @param answer What it answered.
   */
  witness(args: Record<string, unknown>, answer: string): void {
    const strings = (value: unknown): void => {
      if (typeof value === 'string') this.#witnessed.push(bare(value));
      else if (Array.isArray(value)) value.forEach(strings);
      else if (value && typeof value === 'object') Object.values(value).forEach(strings);
    };
    strings(args);
    this.#witnessed.push(answer);
  }

  /**
   * Whether some tool call in the run was given or answered with `location`.
   *
   * @param location The path or URI a declaration names.
   * @returns True when one was.
   */
  seen(location: string): boolean {
    const wanted = bare(location);
    if (!wanted) return false;
    return this.#witnessed.some((text) => text === wanted || text.includes(wanted));
  }

  add(draft: ArtifactDraft | null): void {
    if (!draft) return;
    const earlier = this.#byLocation.get(draft.location);
    if (!earlier) {
      this.#byLocation.set(draft.location, draft);
      return;
    }
    const declared = draft.source === 'declared' ? draft : earlier.source === 'declared' ? earlier : null;
    this.#byLocation.set(draft.location, {
      ...earlier,
      ...draft,
      source: declared ? 'declared' : 'detected',
      action: draft.source === 'declared' ? earlier.action : draft.action,
      serverSlug: draft.serverSlug ?? earlier.serverSlug,
      tool: draft.tool ?? earlier.tool,
      title: declared?.title ?? null,
      description: declared?.description ?? null,
      mediaType: draft.mediaType ?? earlier.mediaType ?? null,
      sizeBytes: draft.sizeBytes ?? earlier.sizeBytes ?? null,
    });
  }

  list(): ArtifactDraft[] {
    return [...this.#byLocation.values()];
  }
}

const MEDIA_TYPES: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  xml: 'application/xml',
  js: 'text/javascript',
  ts: 'text/x-typescript',
  tsx: 'text/x-typescript',
  py: 'text/x-python',
  sh: 'application/x-sh',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  zip: 'application/zip',
};

/**
 * A guess off the extension.
 *
 * @param location The path or URI.
 * @returns The media type, or null for anything this table does not know.
 */
export function mediaTypeFor(location: string): string | null {
  const name = location.split(/[?#]/)[0].split(/[\\/]/).at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return MEDIA_TYPES[name.slice(dot + 1).toLowerCase()] ?? null;
}
