import { AbilityBuilder, createMongoAbility, type ForcedSubject, type MongoAbility, subject } from '@casl/ability';
import type { Actor } from '../core/context.ts';

// What a caller may do, as one CASL ability per request. `defineAbilitiesFor`
// is the only place it is built; the context factory puts it on the context,
// and graphql/permissions.ts asks it before any root field runs.
//
// Today it answers one question: may this caller call this root field? Each
// root field is meant for one audience (graphql/permissions.ts says which),
// and the ability says which audiences each kind of caller is. Which rows a
// caller reaches is still tenancy.ts's (#82, step 2).

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

type CallerAbilities = [typeof CALL, typeof ROOT_FIELD | (RootField & ForcedSubject<typeof ROOT_FIELD>)];

/** A request's ability. */
export type CallerAbility = MongoAbility<CallerAbilities>;

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
