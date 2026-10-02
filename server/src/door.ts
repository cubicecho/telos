import { readFileSync } from 'node:fs';
import { Kind, type OperationDefinitionNode, parse } from 'graphql';
import type { Actor } from './context.ts';

// The MCP door's tools, read from mcp.graphql: the one list the door serves
// (mcp.ts), Settings shows a switch for per key (resolvers/api-keys.ts), and
// the actor lock holds a key to (resolvers/actor-lock.ts). A tool is an
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
 * The tools a caller has switched off. Only a key has switches: a person is
 * not behind the door, and a run gets all of it.
 *
 * @param actor Who is calling.
 * @returns The names of the tools that are off for them.
 */
export function toolsOff(actor: Actor): ReadonlySet<string> {
  return actor.kind === 'apiKey' && actor.toolsOff ? actor.toolsOff : NONE_OFF;
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
