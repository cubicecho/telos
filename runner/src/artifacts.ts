import { ArtifactSource, artifactSource, type RunArtifact, type ToolCallRequest } from '@cubicecho/agent-core';
import { TELOS_SERVER } from './tools.ts';

// Recognising what a run left behind. Pure: nothing here talks to telos, which
// is told once, in the finish.
//
// Most of it is agent-core's: the loop answers `record_artifact` itself, and
// believes a declaration only where some call in the run carried that
// location, since a model left alone with only the board will otherwise "save"
// its answer to a file it never wrote; and it reads every successful call for
// the shape of a write, which is a guess and is sent as one (`detected`). What
// stays here is the board's own: a note the agent adds to its todo is kept as
// a link to that note (`telos:note/<id>`), so the board can open the thread at
// it, and the shape telos stores an artifact in.

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

/**
 * Who offers a tool, by the name the model calls it: `McpPool.describe` bound to
 * the run's pool. Read off the pool rather than out of the name, because the
 * pool shortens a long name and puts a hash on it, and the first `__` of that is
 * not always where the slug ends.
 */
export type DescribeTool = (qualified: string) => { serverId: string; name: string } | undefined;

/**
 * Whether the loop reads a call for a write. The telos door writes notes and
 * requests, which are the board's own and are not artifacts.
 *
 * @param describe Who offers each tool.
 * @returns The predicate: false for the board's tools.
 */
export const detectsFor =
  (describe: DescribeTool) =>
  (call: ToolCallRequest): boolean =>
    describe(call.name)?.serverId !== TELOS_SERVER;

/**
 * One of the loop's artifacts in the shape telos stores. A link has no word in
 * telos's sources yet, and none is asked for, so one that turns up is kept as
 * the guess telos already has a word for.
 *
 * @param artifact What agent-core collected.
 * @param describe Who offers each tool. A tool the pool cannot name keeps the
 *   name it was called by, with no server.
 * @returns The draft.
 */
export function draftOf(artifact: RunArtifact, describe: DescribeTool): ArtifactDraft {
  const { link } = artifact;
  const info = describe(artifact.tool);
  return {
    location: link.uri,
    source: artifactSource(artifact) === ArtifactSource.Declared ? 'declared' : 'detected',
    action: artifact.action ?? 'created',
    serverSlug: info?.serverId ?? null,
    tool: info?.name ?? (artifact.tool || null),
    title: link.title ?? null,
    description: link.description ?? null,
    mediaType: link.mimeType ?? null,
    sizeBytes: artifact.sizeBytes ?? null,
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
 * @param describe Who offers each tool.
 * @returns The draft, or null.
 */
export function noteArtifact(
  name: string,
  args: Record<string, unknown>,
  answer: string,
  todoId: string,
  describe: DescribeTool,
): ArtifactDraft | null {
  const info = describe(name);
  if (info?.serverId !== TELOS_SERVER || info.name !== 'add_todo_note' || args.todoId !== todoId) return null;
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
    serverSlug: info.serverId,
    tool: info.name,
    title: title ? title.slice(0, 120) : null,
    mediaType: 'text/markdown',
    sizeBytes: Buffer.byteLength(body),
  };
}

/**
 * A run's artifacts: the loop's, and the notes it left on its todo. The loop's
 * are taken whole when it ends, from its result or the failure it threw, since
 * a failed run's files are listed too.
 */
export class ArtifactLog {
  #fromLoop: ArtifactDraft[] = [];
  readonly #notes: ArtifactDraft[] = [];

  note(draft: ArtifactDraft | null): void {
    if (draft) this.#notes.push(draft);
  }

  /**
   * What the loop collected.
   *
   * @param artifacts The loop's `artifacts`.
   * @param describe Who offers each tool, asked now, while the pool is open.
   */
  fromLoop(artifacts: RunArtifact[], describe: DescribeTool): void {
    this.#fromLoop = artifacts.map((artifact) => draftOf(artifact, describe));
  }

  list(): ArtifactDraft[] {
    return [...this.#fromLoop, ...this.#notes];
  }
}
