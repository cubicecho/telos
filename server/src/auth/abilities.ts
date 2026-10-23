import {
  AbilityBuilder,
  createMongoAbility,
  type ForcedSubject,
  type MongoAbility,
  type MongoQuery,
  subject,
} from '@casl/ability';
import { Actions } from '@vantreeseba/graphql-casl';
import type { Actor } from '../core/context.ts';
import { ALL_TABLES, aiReach, type Conditions, ownRows, type RowSubject } from './rows.ts';

// What a caller may do, as one CASL ability per request. `defineAbilitiesFor`
// is the only place it is built; the context factory puts it on the context,
// and graphql/permissions.ts asks it before any root field runs.
//
// It answers two questions. May this caller call this root field? Each root
// field is meant for one audience (graphql/permissions.ts says which), and the
// ability says which audiences each kind of caller is. And which rows of each
// table does it reach? Those rules are stated as conditions (auth/rows.ts),
// and auth/sql-filter.ts folds them into the SQL that tenancy's scope and the
// hand-written lookups run under (graphql/tenancy.ts, core/owned.ts). The root
// field says what a caller may do; the row rules say to which rows.

/** The root types, whose fields are what the ability gates. */
export const RootType = {
  Query: 'Query',
  Mutation: 'Mutation',
  Subscription: 'Subscription',
} as const;
export type RootType = (typeof RootType)[keyof typeof RootType];

/** Who a root field is meant for. Every root field is meant for exactly one. */
export const Audience = {
  /** A person only: their account, settings, switches, keys and agents, and the board's structural edits. */
  Person: 'person',
  /** A person, or AI working for them: every read, and the writes the MCP door offers. */
  PersonOrAi: 'personOrAi',
  /** The runner only: claiming, renewing and finishing work. */
  Runner: 'runner',
} as const;
export type Audience = (typeof Audience)[keyof typeof Audience];

/** One root field, as the ability is asked about it. */
export interface RootField {
  root: RootType;
  name: string;
  audience: Audience;
}

/** The subject name a {@link RootField} is checked under. */
const ROOT_FIELD = 'RootField';

/** Calling a root field: the one action the ability is asked about so far. */
export const CALL = 'call';

type CallAbilities = [typeof CALL, typeof ROOT_FIELD | (RootField & ForcedSubject<typeof ROOT_FIELD>)];

/**
 * Reaching a table's rows. A rule is stated as `manage`, since the root field
 * already said which of read, write and delete the caller may do, and asked
 * as `read`, which `manage` answers.
 */
type RowAbilities = [typeof Actions.manage | typeof Actions.read, RowSubject];

type CallerAbilities = CallAbilities | RowAbilities;

/** A request's ability. */
export type CallerAbility = MongoAbility<CallerAbilities>;

/**
 * The rows each table's rule reaches for a caller, or nothing for a table it
 * reaches none of.
 *
 * @param actor - Who is asking.
 * @returns The conditions per table.
 */
function rowsFor(actor: Actor): Array<[RowSubject, Conditions]> {
  const { userId } = actor;
  if (!userId || actor.kind === 'system' || actor.kind === 'anonymous') return [];
  const ai = actor.kind === 'apiKey' || actor.kind === 'agent' ? aiReach(userId) : {};
  const rows: Array<[RowSubject, Conditions]> = [];
  for (const table of ALL_TABLES) {
    const narrowed = ai[table];
    if (narrowed === null) continue;
    rows.push([table, narrowed ?? ownRows(table, userId)]);
  }
  return rows;
}

/**
 * What a caller may do.
 *
 * - A person may call what is meant for a person, and what is meant for a
 *   person or AI. So may nobody: an anonymous caller passes the gate and is
 *   answered UNAUTHENTICATED by the field itself, which is what the app drops
 *   a stale session on.
 * - AI (an `apiKey` or `agent` actor) may call only what is meant for a person
 *   or AI. Its key's switches and its reach are held after that
 *   (graphql/permissions.ts).
 * - The runner may call its own fields, and read: it owns no rows, so every
 *   read but its own answers UNAUTHENTICATED.
 *
 * Rows: a person reaches their own; AI reaches what AI may see of them
 * (`aiReach`); the runner and nobody reach none.
 *
 * @param actor - Who is asking.
 * @returns Their ability.
 */
export function defineAbilitiesFor(actor: Actor): CallerAbility {
  const { can, build } = new AbilityBuilder<CallerAbility>(createMongoAbility);
  switch (actor.kind) {
    case 'system':
      can(CALL, ROOT_FIELD, { audience: Audience.Runner });
      can(CALL, ROOT_FIELD, { root: RootType.Query });
      break;
    case 'apiKey':
    case 'agent':
      can(CALL, ROOT_FIELD, { audience: Audience.PersonOrAi });
      break;
    case 'user':
    case 'anonymous':
      can(CALL, ROOT_FIELD, { audience: { $in: [Audience.Person, Audience.PersonOrAi] } });
      break;
  }
  for (const [table, conditions] of rowsFor(actor)) {
    // A table is named by a string, which CASL types as having no fields, so
    // it types the conditions as matching none. They are paths through
    // RELATIONS (auth/rows.ts), which auth/sql-filter.ts checks instead.
    can(Actions.manage, table, conditions as MongoQuery<never>);
  }
  return build();
}

/**
 * Whether a caller may call a root field.
 *
 * @param ability - The caller's ability.
 * @param field - The field.
 * @returns true when it may.
 */
export function mayCall(ability: CallerAbility, field: RootField): boolean {
  return ability.can(CALL, subject(ROOT_FIELD, { ...field }));
}
