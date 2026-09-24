import { defaultFieldResolver, GraphQLError, type GraphQLObjectType, type GraphQLSchema } from 'graphql';
import { type Context, isAiActor } from '../context.ts';

// What AI may write. An MCP client or an agent adds work and says things about
// it; it never moves cards, completes them, edits them or touches settings.
// That is the separation: the board is the person's, and policy (where a todo
// goes when a run ends) is the server's, not the caller's.
//
// An allowlist over the whole Mutation type rather than a check per resolver,
// so a mutation added later is closed to AI until someone opens it here.
// Applied last in createSchema, after every extension has added its fields.

/** The only mutations an AI caller may make. */
export const AI_MUTATIONS = new Set(['submitRequest', 'cancelRequest', 'addTodoNote']);

export function applyActorLock(schema: GraphQLSchema): GraphQLSchema {
  const mutation = schema.getMutationType() as GraphQLObjectType | null | undefined;
  if (!mutation) return schema;
  for (const [name, field] of Object.entries(mutation.getFields())) {
    if (AI_MUTATIONS.has(name)) continue;
    const resolve = field.resolve ?? defaultFieldResolver;
    field.resolve = (parent, args, context: Context, info) => {
      if (isAiActor(context)) {
        throw new GraphQLError(`${name} is not open to AI. Submit a request instead.`, {
          extensions: { code: 'FORBIDDEN' },
        });
      }
      return resolve(parent, args, context, info);
    };
  }
  return schema;
}
