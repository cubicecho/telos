import { GraphQLEnumType, type GraphQLNamedType, GraphQLSchema } from 'graphql';

// The API's hand-written enums, each beside the values the code reads.
//
// On the wire a value is SCREAMING_CASE (`HANDED_BACK`); inside the server it
// stays the word the code and the database use (`handedBack`). The enum type
// translates both ways, so a resolver returns `'handedBack'` and receives
// `'header'`, never the wire name.
//
// Enums over a table's column are generated from the column instead, once
// drizzle-graphql can name their values this way:
// https://github.com/cubicecho/drizzle-graphql/issues/178

/** `handedBack` → `HANDED_BACK`, `tool_call` → `TOOL_CALL`. */
function wireName(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/**
 * A GraphQL enum over `values`, named for the wire.
 *
 * @param name The type's name in SDL.
 * @param values The values the server reads and writes.
 * @param description What the enum is, for the schema.
 * @returns The enum type, for an extension's SDL to refer to by name.
 */
function serverEnum(name: string, values: readonly string[], description: string): GraphQLEnumType {
  return new GraphQLEnumType({
    name,
    description,
    values: Object.fromEntries(values.map((value) => [wireName(value), { value }])),
  });
}

/**
 * The schema with `enums` added, so an extension's SDL can name them. An enum
 * the schema already has is left as it is, since two extensions may share one.
 *
 * @param schema The schema so far.
 * @param enums The enums the extension's SDL refers to.
 * @returns The schema with every one of them.
 */
export function withEnums(schema: GraphQLSchema, enums: GraphQLEnumType[]): GraphQLSchema {
  const missing: GraphQLNamedType[] = enums.filter((type) => schema.getType(type.name) === undefined);
  if (missing.length === 0) return schema;
  const config = schema.toConfig();
  return new GraphQLSchema({ ...config, types: [...config.types, ...missing] });
}

/** Where a todo stands with its lane's agent, for a person reading the board. In `aiStatus`'s order. */
export const WORK_STATES = ['handedBack', 'running', 'waiting', 'blocked', 'queued', 'parked', 'done'] as const;
export type WorkState = (typeof WORK_STATES)[number];
export const WorkStateEnum = serverEnum(
  'WorkState',
  WORK_STATES,
  "Where a todo stands with its lane's agent: HANDED_BACK, RUNNING, WAITING (an umbrella, done when its pieces are), BLOCKED, QUEUED, PARKED or DONE.",
);

/** Why a lane's agent handed a todo back. */
export const HAND_BACKS = ['gaveUp', 'finished'] as const;
export type HandBack = (typeof HAND_BACKS)[number];
export const HandBackEnum = serverEnum(
  'HandBack',
  HAND_BACKS,
  "Why a lane's agent handed a todo back: GAVE_UP (it failed more times than the lane allows) or FINISHED (with nowhere to send it).",
);

/** Where a test of an MCP server has got to. */
export const MCP_PROBE_STATUSES = ['pending', 'testing', 'done'] as const;
export type McpProbeStatus = (typeof MCP_PROBE_STATUSES)[number];
export const McpProbeStatusEnum = serverEnum(
  'McpProbeStatus',
  MCP_PROBE_STATUSES,
  'Where a test of an MCP server has got to: PENDING (waiting for the runner), TESTING or DONE.',
);

/** Which of an MCP server's secrets: a header, or an environment variable. */
export const MCP_SECRET_KINDS = ['header', 'env'] as const;
export type McpSecretKind = (typeof MCP_SECRET_KINDS)[number];
export const McpSecretKindEnum = serverEnum(
  'McpSecretKind',
  MCP_SECRET_KINDS,
  "Which of an MCP server's secrets: a HEADER sent to its URL, or an ENV variable in its command's environment.",
);

/** What a change-feed entry is about. */
export const CHANGE_ENTITIES = ['project', 'todo', 'dependency'] as const;
export type ChangeEntity = (typeof CHANGE_ENTITIES)[number];
export const ChangeEntityEnum = serverEnum('ChangeEntity', CHANGE_ENTITIES, 'What a change-feed entry is about.');

/** What happened in a run, for the live view. */
export const RUN_EVENT_KINDS = ['tool_call', 'tool_result', 'hook', 'notice', 'turn', 'thinking', 'output'] as const;
export type RunEventKind = (typeof RUN_EVENT_KINDS)[number];
export const RunEventKindEnum = serverEnum(
  'RunEventKind',
  RUN_EVENT_KINDS,
  'What happened in a run: TOOL_CALL, TOOL_RESULT, HOOK, NOTICE, TURN, THINKING or OUTPUT.',
);

/** How a run can end, as the runner reports it. */
export const RUN_OUTCOMES = ['ok', 'error', 'stopped'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];
export const RunOutcomeEnum = serverEnum('RunOutcome', RUN_OUTCOMES, 'How a run ended: OK, ERROR or STOPPED.');
