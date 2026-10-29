import { applyPermissions, chain, type PermissionsMap, type Rule, rule } from '@vantreeseba/graphql-casl';
import type { GraphQLResolveInfo, GraphQLSchema } from 'graphql';
import { assertAiReach } from '../ai/reach.ts';
import { Audience, mayCall, RootType } from '../auth/abilities.ts';
import { type Context, isAiActor } from '../core/context.ts';
import { forbidden } from '../core/errors.ts';
import { DOOR_TOOLS, switchedOff, switchOwner } from '../mcp/door.ts';
import { assertRunReach } from '../runs/run-reach.ts';

// Who may call each root field, as a graphql-casl permissions map over the
// finished schema. Every root field is named here with the audience it is
// meant for (`ROOT_FIELDS`, or the defaults for generated CRUD), and the
// caller's ability (auth/abilities.ts) says which audiences it is. A root
// field named nowhere is refused to everyone, so a field added later is
// closed until someone says who it is for.
//
// What AI may write is a person's board work: make a project, add todos and
// move them, send one round again, stop a run, record what it made. What stays
// a person's is everything that decides how far AI reaches: the AI switches,
// keys and secrets, agents and their MCP servers, deleting a project, and
// changing many rows at once.
//
// Past the audience, three things narrow an AI caller, in this order. A key
// has a switch per tool of the door (mcp/door.ts, `setApiKeyTools`), as a run
// does through its agent (`agents.tools_off`): a root field every tool of which
// is off for the caller is refused. What it sees is less than its user does
// (tenancy.ts), and a mutation's ids are held to that before it runs
// (ai/reach.ts). And a run is held to its own todo's tree and its own board,
// whatever its switches say (runs/run-reach.ts).
//
// A note is its author's to take back: `editTodoNote` and `deleteTodoNote`
// hold a caller to the notes it signed (todos/notes.ts). `recordArtifact`
// is how a client says what it made; a run has its own way (runs/artifacts.ts).
//
// Only the root types are in the map. graphql-casl's `fallbackRule` would
// guard every field of every type, wrapping each scalar of each row in a rule
// that can only ever pass; a `'*'` entry on each root type is the same
// deny-by-default where it decides anything. Applied last in createSchema, in
// place, after every extension has added its fields.

/** The root fields that are not generated CRUD, and generated ones meant for someone else than the default. */
export const ROOT_FIELDS: Record<RootType, Partial<Record<Audience, readonly string[]>>> = {
  [RootType.Query]: {
    [Audience.Person]: [
      'cardMarks',
      'apiKeys',
      'mcpTools',
      'mcpProbe',
      'agentModels',
      'agentDefaults',
      'accountSpend',
      'accountHandedBack',
      'instanceRunLimit',
    ],
    [Audience.PersonOrAi]: [
      'authConfig',
      'ssoSetup',
      'getSession',
      'listSessions',
      'changes',
      'aiStatus',
      'aiSetup',
      'agentRoster',
      'aiSpend',
      'defaultAgentInstructions',
    ],
    [Audience.Runner]: ['runnerQueue', 'runnerProbes'],
  },
  [RootType.Mutation]: {
    [Audience.Person]: [
      'signInMagicLink',
      'magicLinkVerify',
      'verifyOneTimeToken',
      'signOut',
      'revokeSession',
      'revokeSessions',
      'revokeOtherSessions',
      'pairSso',
      'unpairSso',
      'createApiKey',
      'deleteApiKey',
      'setApiKeyTools',
      'setInstanceAiEnabled',
      'setInstanceRunLimit',
      'setAiEnabled',
      'setProjectAiEnabled',
      'setProjectAiMode',
      'setRunRetention',
      'completeTodo',
      'reopenTodo',
      'unsplitTodo',
      'addTodoDependency',
      'removeTodoDependency',
      'setDoneLane',
      'reorderLanes',
      'setAgentApiKey',
      'setMcpServerSecret',
      'testMcpServer',
      'setAgentDefaults',
      'setAgentDefaultsApiKey',
      'setAgentInstructions',
      'deleteRun',
      'deleteArtifact',
    ],
    // The MCP door's mutations are exactly these (mcp/door.graphql), which
    // __tests__/mcp/mcp.test.ts holds it to.
    [Audience.PersonOrAi]: [
      'submitRequest',
      'cancelRequest',
      'addTodoNote',
      'answerTodo',
      'editTodoNote',
      'deleteTodoNote',
      'recordArtifact',
      'createProject',
      'updateProject',
      'createTodo',
      'updateTodo',
      'deleteTodo',
      'restoreTodo',
      'moveTodo',
      'setTodoDependencies',
      'retryTodo',
      'runTodo',
      'cancelRun',
      'saveBoardTemplate',
      'applyBoardTemplate',
    ],
    // It owns no rows, so generated CRUD would refuse it anyway; this says so
    // plainly, and keeps it that way for mutations that do not ask for a user.
    [Audience.Runner]: [
      'claimRun',
      'heartbeatRun',
      'finishRun',
      'finishProbe',
      'takeSessionDeletes',
      'finishSessionDelete',
    ],
  },
  // graphql-casl guards a subscription field's `resolve` when it has one, so
  // this rule runs on each event rather than on subscribing: the field holds
  // its caller to a person itself, before it listens (board/board-changed.ts).
  [RootType.Subscription]: {
    [Audience.Person]: ['boardChanged'],
  },
};

/**
 * Who generated CRUD is for. Every read is tenancy's to narrow, so AI may make
 * them all; a generated write is a person's unless `ROOT_FIELDS` opens it.
 */
const GENERATED_AUDIENCE = {
  [RootType.Query]: Audience.PersonOrAi,
  [RootType.Mutation]: Audience.Person,
} as const;

/** The only mutations an AI caller may make. */
export const AI_MUTATIONS: ReadonlySet<string> = new Set(ROOT_FIELDS.Mutation[Audience.PersonOrAi]);

/** The only mutations the runner may make. */
export const RUNNER_MUTATIONS: ReadonlySet<string> = new Set(ROOT_FIELDS.Mutation[Audience.Runner]);

/** The generated root fields, by root type: drizzle-graphql's `entities`. */
export interface GeneratedFields {
  queries: Record<string, unknown>;
  mutations: Record<string, unknown>;
}

/** A field's arguments, which GraphQL always hands over as an object. */
type FieldArgs = Record<string, unknown>;

/** The root fields the door's read tools call, which a key's switches close as they do its writes. */
const READ_TOOL_FIELDS: ReadonlySet<string> = new Set(
  DOOR_TOOLS.filter((tool) => !tool.writes).flatMap((tool) => tool.fields),
);

/**
 * The refusal a caller gets for a field not meant for it.
 *
 * @param context - The request.
 * @param name - The field.
 * @returns The error.
 */
function notForCaller(context: Context, name: string): Error {
  if (context.actor.kind === 'system') {
    return forbidden(`${name} is not open to the runner.`);
  }
  if (isAiActor(context)) {
    return forbidden(`${name} is not open to AI.`);
  }
  return forbidden(`${name} is the runner's alone.`);
}

/**
 * The rule for the fields meant for one audience: the caller's ability decides.
 *
 * @param audience - Who the fields are for.
 * @returns The rule.
 */
function forAudience(audience: Audience) {
  return rule(
    (_parent, _args, context: Context, info: GraphQLResolveInfo) => {
      const field = { root: info.parentType.name as RootType, name: info.fieldName, audience };
      return mayCall(context.ability, field) || notForCaller(context, info.fieldName);
    },
    { name: `for(${audience})` },
  );
}

/** A person only. */
export const isPerson = forAudience(Audience.Person);
/** A person, or AI working for them. */
export const isPersonOrAi = forAudience(Audience.PersonOrAi);
/** The runner only. */
export const isRunner = forAudience(Audience.Runner);

const AUDIENCE_RULE: Record<Audience, Rule> = {
  [Audience.Person]: isPerson,
  [Audience.PersonOrAi]: isPersonOrAi,
  [Audience.Runner]: isRunner,
};

/** Refuses a root field every tool of which the caller's switches have off. */
const switchesOn = rule(
  (_parent, args, context: Context, info: GraphQLResolveInfo) =>
    !switchedOff(info.fieldName, args as FieldArgs, context.actor) ||
    forbidden(`${info.fieldName} is switched off for ${switchOwner(context.actor)}.`),
  { name: 'switchesOn' },
);

/** Refuses a mutation whose ids name something its AI caller may not see (ai/reach.ts). */
const withinAiReach = rule(
  async (_parent, args, context: Context, info: GraphQLResolveInfo) => {
    if (isAiActor(context)) await assertAiReach(info.fieldName, args as FieldArgs, context);
    return true;
  },
  { name: 'withinAiReach' },
);

/** Refuses a mutation that reaches past its run's own todo and board (runs/run-reach.ts). */
const withinRunReach = rule(
  async (_parent, args, context: Context, info: GraphQLResolveInfo) => {
    if (context.actor.kind === 'agent') await assertRunReach(info.fieldName, args as FieldArgs, context);
    return true;
  },
  { name: 'withinRunReach' },
);

/** What a root field no one has said is for gets: a refusal naming the fix. */
const unlisted = rule(
  (_parent, _args, _context, info: GraphQLResolveInfo) =>
    forbidden(
      `${info.parentType.name}.${info.fieldName} is open to no one: say who it is for in ROOT_FIELDS (graphql/permissions.ts).`,
    ),
  { name: 'unlisted' },
);

/**
 * The full rule for one root field: its audience, then what narrows an AI
 * caller past it.
 *
 * @param root - The field's root type.
 * @param name - The field.
 * @param audience - Who it is for.
 * @returns The rule.
 */
function ruleFor(root: RootType, name: string, audience: Audience): Rule {
  const gate = AUDIENCE_RULE[audience];
  if (root === RootType.Mutation) return chain(gate, switchesOn, withinAiReach, withinRunReach);
  if (root === RootType.Query && READ_TOOL_FIELDS.has(name)) return chain(gate, switchesOn);
  return gate;
}

/**
 * The permissions map for a schema: every field `ROOT_FIELDS` names that the
 * schema has, every generated field, and a refusal for the rest. With AI off
 * the schema lacks the AI fields, so they are left out rather than named.
 *
 * @param schema - The finished schema.
 * @param generated - drizzle-graphql's generated root fields.
 * @returns The map.
 */
export function permissionsFor(schema: GraphQLSchema, generated: GeneratedFields): PermissionsMap {
  const roots = {
    [RootType.Query]: { type: schema.getQueryType(), generated: Object.keys(generated.queries) },
    [RootType.Mutation]: { type: schema.getMutationType(), generated: Object.keys(generated.mutations) },
    [RootType.Subscription]: { type: schema.getSubscriptionType(), generated: [] as string[] },
  };
  const map: Record<string, Record<string, Rule>> = {};
  for (const [root, { type, generated: names }] of Object.entries(roots) as [RootType, (typeof roots)[RootType]][]) {
    if (!type) continue;
    const present = type.getFields();
    const entries: Record<string, Rule> = { '*': unlisted };
    const audiences = Object.entries(ROOT_FIELDS[root]) as [Audience, readonly string[]][];
    const defaultAudience = root === RootType.Subscription ? undefined : GENERATED_AUDIENCE[root];
    if (defaultAudience) {
      for (const name of names) entries[name] = ruleFor(root, name, defaultAudience);
    }
    for (const [audience, fields] of audiences) {
      for (const name of fields) {
        if (name in present) entries[name] = ruleFor(root, name, audience);
      }
    }
    map[root] = entries;
  }
  return map;
}

/**
 * Applies the permissions map to the finished schema, in place.
 *
 * @param schema - The schema, with every extension's fields.
 * @param generated - drizzle-graphql's generated root fields.
 * @returns The same schema, guarded.
 */
export function applyCallerPermissions(schema: GraphQLSchema, generated: GeneratedFields): GraphQLSchema {
  return applyPermissions(schema, permissionsFor(schema, generated), { inPlace: true });
}
