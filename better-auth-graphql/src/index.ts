import { extendSchema, type GraphQLSchema, isObjectType, parse } from 'graphql';
import type { JsonSchema } from './json-schema.ts';
import {
  type AuthLike,
  type AuthOperation,
  describeModels,
  describeOperations,
  type OperationKind,
} from './operations.ts';
import { type Around, type AuthResolver, createResolver, type ResolverOptions } from './resolvers.ts';
import { SdlBuilder } from './sdl.ts';

// better-auth over GraphQL. Built from the auth instance itself: every endpoint
// a client may call becomes a field (a GET a query, the rest mutations), its
// body and query become arguments, and its documented response becomes a type.
// What stays HTTP is what has to: OAuth callbacks and other redirect targets,
// which a browser is sent to rather than calls.

export type { JsonSchema } from './json-schema.ts';
export type { AuthArg, AuthLike, AuthOperation, OperationKind } from './operations.ts';
export { describeModels, describeOperations } from './operations.ts';
export type { Around, AuthResolver, OperationCall, ResolverOptions } from './resolvers.ts';
export { toGraphQLError } from './resolvers.ts';

export interface BetterAuthGraphQLOptions<TContext> extends ResolverOptions<TContext> {
  /**
   * Which operations to serve, by endpoint name (`signInEmail`). An array is an
   * allowlist; a function decides. Defaults to every one.
   */
  include?: readonly string[] | ((operation: AuthOperation) => boolean) | undefined;
  /** Operations never to serve, by endpoint name. Applied after `include`. */
  exclude?: readonly string[] | undefined;
  /** Overrides an operation's kind, by endpoint name. */
  kinds?: Record<string, OperationKind> | undefined;
  /** The field an operation is served as. Defaults to its endpoint name. */
  fieldName?: ((operation: AuthOperation) => string) | undefined;
  /** In front of every type made here. Defaults to `Auth` (`AuthUser`, `AuthSignInEmailResult`). */
  typePrefix?: string | undefined;
  /** The scalars dates and untyped values are served as. Defaults to `DateTime` and `JSON`. */
  scalars?: { dateTime?: string | undefined; json?: string | undefined } | undefined;
  /** What to change about one operation, by endpoint name. */
  operations?: Record<string, OperationOptions<TContext>> | undefined;
}

export interface OperationOptions<TContext> {
  /**
   * Arguments not to offer: ones that are not for clients, or that `around`
   * sets itself.
   */
  omitArgs?: readonly string[] | undefined;
  /**
   * The result to serve: a schema to use instead of the documented one, or a
   * function from it. For where better-auth's documentation is wrong, or for
   * the fields an `around` adds.
   */
  result?: ResultPatch | undefined;
  /** Wraps the call: see `Around`. */
  around?: Around<TContext> | undefined;
}

export type ResultPatch = JsonSchema | ((documented: JsonSchema | undefined) => JsonSchema | undefined);

/** Where better-auth's documented responses leave out what it returns (as of 1.7). */
const RESULT_PATCHES: Record<string, ResultPatch> = {
  // Documented as `{ session, user }`; also returns the session token.
  magicLinkVerify: (documented) =>
    documented?.properties
      ? {
          ...documented,
          properties: { token: { type: 'string' }, ...documented.properties },
          required: ['token', ...(documented.required ?? [])],
        }
      : documented,
  // Documented as `{ user }`; returns `{ status: true }`.
  updateUser: { type: 'object', properties: { status: { type: 'boolean' } }, required: ['status'] },
};

export interface BetterAuthGraphQL<TContext> {
  /** The operations served, in `auth.api` order. */
  operations: AuthOperation[];
  /** The SDL: the types, then `extend type Query` and `extend type Mutation`. No scalar declarations. */
  typeDefs: string;
  /** The scalars `typeDefs` uses, for a host to declare if it has not. */
  scalars: { dateTime: string; json: string };
  /** Resolvers by root type and field. */
  resolvers: { Query: Record<string, AuthResolver<TContext>>; Mutation: Record<string, AuthResolver<TContext>> };
}

/**
 * better-auth's endpoints as SDL and resolvers, for any GraphQL server. Pair it
 * with `applyBetterAuthGraphQL` to extend a graphql-js schema in place.
 */
export function betterAuthGraphQL<TContext>(
  auth: AuthLike,
  options: BetterAuthGraphQLOptions<TContext>,
): BetterAuthGraphQL<TContext> {
  const { include, exclude, kinds } = options;
  const excluded = new Set(exclude ?? []);
  const overrides = options.operations ?? {};
  const operations = describeOperations(auth, { kinds })
    .filter(
      (operation) =>
        !excluded.has(operation.name) &&
        (include === undefined ||
          (typeof include === 'function' ? include(operation) : include.includes(operation.name))),
    )
    .map((operation) => withOverrides(operation, RESULT_PATCHES[operation.name], overrides[operation.name]));

  const fieldName = options.fieldName ?? ((operation: AuthOperation) => operation.name);
  const scalars = { dateTime: options.scalars?.dateTime ?? 'DateTime', json: options.scalars?.json ?? 'JSON' };
  const builder = new SdlBuilder(
    { typePrefix: options.typePrefix ?? 'Auth', dateTime: scalars.dateTime, json: scalars.json, fieldName },
    describeModels(auth.options),
  );
  const typeDefs = builder.build(operations);

  const resolvers: BetterAuthGraphQL<TContext>['resolvers'] = { Query: {}, Mutation: {} };
  for (const operation of operations) {
    const root = operation.kind === 'query' ? resolvers.Query : resolvers.Mutation;
    root[fieldName(operation)] = createResolver(auth, operation, options, overrides[operation.name]?.around);
  }

  return { operations, typeDefs, scalars, resolvers };
}

/** An operation less the arguments it should not offer, with its result patched: ours first, then the host's. */
function withOverrides<TContext>(
  operation: AuthOperation,
  patch: ResultPatch | undefined,
  overrides: OperationOptions<TContext> | undefined,
): AuthOperation {
  let result = operation.result;
  for (const step of [patch, overrides?.result]) {
    if (step) result = typeof step === 'function' ? step(result) : step;
  }
  const omit = new Set(overrides?.omitArgs ?? []);
  const args = Object.fromEntries(Object.entries(operation.args).filter(([name]) => !omit.has(name)));
  return { ...operation, args, result };
}

/**
 * Extends `schema` with the operations and sets their resolvers. A scalar the
 * schema does not have yet is declared; the resolvers hand it JSON values.
 *
 * @throws If a field it adds is already on Query or Mutation.
 */
export function applyBetterAuthGraphQL<TContext>(
  schema: GraphQLSchema,
  built: BetterAuthGraphQL<TContext>,
): GraphQLSchema {
  const declarations = [built.scalars.dateTime, built.scalars.json]
    .filter((name, index, all) => all.indexOf(name) === index && !schema.getType(name))
    .map((name) => `scalar ${name}`);
  // `extend type` needs the type to exist. A schema without one gets it
  // declared, and made the root: a type named Mutation is not one by name alone.
  let typeDefs = built.typeDefs;
  const newRoots: string[] = [];
  for (const [root, existing] of [
    ['Query', schema.getQueryType()],
    ['Mutation', schema.getMutationType()],
  ] as const) {
    if (existing || !typeDefs.includes(`extend type ${root} {`)) continue;
    typeDefs = typeDefs.replace(`extend type ${root} {`, `type ${root} {`);
    newRoots.push(`${root.toLowerCase()}: ${root}`);
  }
  if (newRoots.length) typeDefs += `\nextend schema { ${newRoots.join(' ')} }\n`;

  const extended = extendSchema(schema, parse([...declarations, typeDefs].join('\n\n')));
  for (const [rootName, fields] of Object.entries(built.resolvers)) {
    const root = rootName === 'Query' ? extended.getQueryType() : extended.getMutationType();
    if (!root || !isObjectType(root)) continue;
    const fieldMap = root.getFields();
    for (const [name, resolve] of Object.entries(fields)) {
      const field = fieldMap[name];
      if (field) field.resolve = resolve as typeof field.resolve;
    }
  }
  return extended;
}
