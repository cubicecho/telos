import { readFileSync } from 'node:fs';
import { Kind, type OperationDefinitionNode, parse } from 'graphql';
import type { Actor } from './context.ts';

// The MCP door's tools, read from mcp.graphql: the one list the door serves
// (mcp.ts), Settings shows a switch for per key (resolvers/api-keys.ts) and
// per agent (`agents.tools_off`), and the actor lock holds a key or a run to
// (resolvers/actor-lock.ts). A tool is an
// operation in that file and nothing else, so this is never a second list to
// keep in step with it.

/** Where the door's operations are. */
export const OPERATIONS_PATH = new URL('./mcp.graphql', import.meta.url);

/** One tool of the door. */
export interface DoorTool {
  /** The tool's name, as an MCP client sees it. */
  name: string;
  /** Whether it changes anything. */
  writes: boolean;
  /** What it does, as the client is told. */
  description: string;
  /** The root fields its operation calls. */
  fields: string[];
}

const COMMENT = /^\s*#\s?/;

/**
 * An operation's name as a tool name.
 *
 * @param operation The operation's name, in camel case.
 * @returns It in snake case, as graphql-mcp names the tool.
 */
function toolName(operation: string): string {
  return operation.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * The comment written above an operation, which is its tool's description.
 *
 * @param lines The file, by line.
 * @param line The operation's own line, from one.
 * @returns The comment as one paragraph.
 */
function commentAbove(lines: string[], line: number): string {
  const comment: string[] = [];
  for (let at = line - 2; at >= 0 && COMMENT.test(lines[at]); at--) {
    comment.unshift(lines[at].replace(COMMENT, '').trim());
  }
  return comment.join(' ');
}

/**
 * Reads the door's tools out of its operations.
 *
 * @param source The operations document.
 * @returns A tool per operation, in the order written.
 */
export function readDoorTools(source: string): DoorTool[] {
  const lines = source.split('\n');
  return parse(source)
    .definitions.filter((definition): definition is OperationDefinitionNode => {
      return definition.kind === Kind.OPERATION_DEFINITION && definition.name !== undefined;
    })
    .map((operation) => ({
      name: toolName(operation.name?.value ?? ''),
      writes: operation.operation === 'mutation',
      description: commentAbove(lines, operation.loc?.startToken.line ?? 0),
      fields: operation.selectionSet.selections.flatMap((selection) => {
        return selection.kind === Kind.FIELD ? [selection.name.value] : [];
      }),
    }));
}

/** The operations document the door serves. */
export const DOOR_OPERATIONS = readFileSync(OPERATIONS_PATH, 'utf8');

/** Every tool the door has. */
export const DOOR_TOOLS: readonly DoorTool[] = readDoorTools(DOOR_OPERATIONS);

/** The names of the door's tools. */
export const DOOR_TOOL_NAMES: ReadonlySet<string> = new Set(DOOR_TOOLS.map((tool) => tool.name));

/** The mutation one field of which is two tools, told apart by its `hard` argument. */
const DELETE_TODO = 'deleteTodo';
const DELETE_TOOL = 'delete_todo';
const ARCHIVE_TOOL = 'archive_todo';

/**
 * The tools that call a root field.
 *
 * @param field The root field's name.
 * @param args The arguments it was called with.
 * @returns Their names. Empty for a field no tool calls.
 */
export function toolsCalling(field: string, args: Record<string, unknown>): string[] {
  const tools = DOOR_TOOLS.filter((tool) => tool.fields.includes(field)).map((tool) => tool.name);
  if (field !== DELETE_TODO) {
    return tools;
  }
  // Archiving and deleting for good are one field. Switching one off must not
  // leave it reachable as the other.
  const meant = args.hard === true ? DELETE_TOOL : ARCHIVE_TOOL;
  return tools.filter((tool) => tool === meant);
}

/**
 * The writing tools a run has unless its agent says otherwise: it adds work,
 * leaves notes and takes back its own. Every reading tool is on as well. What
 * changes work already on the board, or reaches past it (projects, requests,
 * drafts, templates), a person turns on for an agent that should have it.
 */
export const RUN_DEFAULT_WRITES: ReadonlySet<string> = new Set([
  'create_todo',
  'set_todo_dependencies',
  'add_todo_note',
  'edit_todo_note',
  'delete_todo_note',
]);

/**
 * Door tools a run never has, whatever its agent says. A run records what it
 * made with the runner's own `record_artifact`, which the runner checks; the
 * door's is a client's word, and is refused for a run (resolvers/artifacts.ts).
 */
export const NOT_FOR_RUNS: ReadonlySet<string> = new Set(['record_artifact']);

/**
 * Whether a run has a tool when its agent has never said: every read, and the
 * writes in `RUN_DEFAULT_WRITES`. A tool added to the door later follows the
 * same rule, so a new write is off for runs until a person turns it on.
 *
 * @param tool The tool.
 * @returns Whether it is on by default for a run.
 */
export function onForRuns(tool: DoorTool): boolean {
  return !NOT_FOR_RUNS.has(tool.name) && (!tool.writes || RUN_DEFAULT_WRITES.has(tool.name));
}

/** The tools a run has off when its agent has never said. */
export const RUN_DEFAULT_OFF: readonly string[] = DOOR_TOOLS.filter((tool) => !onForRuns(tool)).map(
  (tool) => tool.name,
);

/**
 * The tools a run has off: its agent's list (`agents.tools_off`), or the
 * default when the agent has none or is gone. The ones no run has are off
 * either way.
 *
 * @param stored The agent's list, as stored. Null when it has none.
 * @returns The names of the tools that are off for its runs.
 */
export function runToolsOff(stored: unknown): ReadonlySet<string> {
  const list = Array.isArray(stored) ? stored.filter((name): name is string => typeof name === 'string') : null;
  return new Set([...(list ?? RUN_DEFAULT_OFF), ...NOT_FOR_RUNS]);
}

/**
 * The tools a caller has switched off. A key has its owner's switches, and a
 * run its agent's (both put on the actor by auth.ts); a person is not behind
 * the door. A run whose actor carries none, which only a test builds, gets the
 * default rather than everything.
 *
 * @param actor Who is calling.
 * @returns The names of the tools that are off for them.
 */
export function toolsOff(actor: Actor): ReadonlySet<string> {
  if (actor.kind === 'agent') {
    return actor.toolsOff ?? runToolsOff(null);
  }
  return actor.kind === 'apiKey' && actor.toolsOff ? actor.toolsOff : NONE_OFF;
}

/**
 * Whose switch a refusal names.
 *
 * @param actor Who is calling.
 * @returns The words for it.
 */
export function switchOwner(actor: Actor): string {
  return actor.kind === 'agent' ? "this run's agent" : 'this key';
}

const NONE_OFF: ReadonlySet<string> = new Set();

/**
 * Whether a root field is closed to a caller by their switches: some tool calls
 * it, and every tool that does is off.
 *
 * @param field The root field's name.
 * @param args The arguments it was called with.
 * @param actor Who is calling.
 * @returns Whether the switches close it.
 */
export function switchedOff(field: string, args: Record<string, unknown>, actor: Actor): boolean {
  const off = toolsOff(actor);
  if (off.size === 0) {
    return false;
  }
  const tools = toolsCalling(field, args);
  return tools.length > 0 && tools.every((tool) => off.has(tool));
}
