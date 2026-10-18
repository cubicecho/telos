import { type GraphQLFieldResolver, type GraphQLSchema, isObjectType } from 'graphql';
import type { Resolvers } from '../../__generated__/resolvers.ts';
import type { Context } from '../core/context.ts';

// An extension's resolvers, as one map typed by codegen (`npm run codegen`), so
// a field's args, parent and result are checked against the schema it serves.
// The schema is mutated in place, as `extendSchema`'s result is the extension's
// own copy.

type AnyResolver = GraphQLFieldResolver<unknown, Context>;

/**
 * Sets each field's resolver in `resolvers` on `schema`.
 *
 * @param schema The extended schema, with every type and field the map names.
 * @param resolvers Resolvers by type and field: a function, or `{ subscribe, resolve }` on Subscription.
 * @returns The same schema.
 * @throws If the map names a type or field the schema does not have.
 */
export function attachResolvers(schema: GraphQLSchema, resolvers: Resolvers): GraphQLSchema {
  for (const [typeName, fields] of Object.entries(resolvers)) {
    const type = schema.getType(typeName);
    if (!isObjectType(type)) throw new Error(`attachResolvers: ${typeName} is not an object type in the schema`);
    const fieldMap = type.getFields();
    for (const [fieldName, resolver] of Object.entries(fields ?? {})) {
      const field = fieldMap[fieldName];
      if (!field) throw new Error(`attachResolvers: ${typeName}.${fieldName} is not in the schema`);
      if (typeof resolver === 'function') {
        field.resolve = resolver as AnyResolver;
      } else {
        const { subscribe, resolve } = resolver as { subscribe?: AnyResolver; resolve?: AnyResolver };
        if (subscribe) field.subscribe = subscribe;
        if (resolve) field.resolve = resolve;
      }
    }
  }
  return schema;
}
