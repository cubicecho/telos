import type { BetterAuthOptions } from 'better-auth';
import { getAuthTables } from 'better-auth/db';
import { type JsonSchema, mergeObjects, typesOf } from './json-schema.ts';

// What an auth instance offers, read off its endpoints. Every endpoint on
// `auth.api` carries its path, its method, zod schemas for its body and query,
// and OpenAPI metadata for its response; plugins add theirs to the same map.
// So the GraphQL surface is derived, never listed: add a better-auth plugin and
// its endpoints appear.

/** A better-auth endpoint, as `auth.api` holds it. */
export interface AuthEndpoint {
  (input: {
    body?: unknown;
    query?: unknown;
    headers?: Headers;
    returnHeaders: true;
  }): Promise<{ headers: Headers | null; response: unknown }>;
  path?: string;
  options?: {
    method?: string | string[];
    body?: ZodLike;
    query?: ZodLike;
    metadata?: {
      scope?: string;
      isAction?: boolean;
      SERVER_ONLY?: boolean;
      openapi?: {
        description?: string;
        requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
        responses?: Record<string, { content?: Record<string, { schema?: JsonSchema }> }>;
      };
    };
  };
}

/** A zod 4 schema, which describes itself as JSON Schema. */
interface ZodLike {
  toJSONSchema(params: { io: 'input'; unrepresentable: 'any' }): JsonSchema;
}

/** An auth instance: what `betterAuth()` returns, whatever its plugins. */
export interface AuthLike {
  api: object;
  options: BetterAuthOptions;
}

export type OperationKind = 'query' | 'mutation';

export interface AuthArg {
  schema: JsonSchema;
  required: boolean;
  /** Where the endpoint reads it. A key both read is sent to both. */
  in: Array<'body' | 'query'>;
}

export interface AuthOperation {
  /** The endpoint's key on `auth.api`, e.g. `signInEmail`. */
  name: string;
  path: string;
  methods: string[];
  kind: OperationKind;
  description: string | undefined;
  /** The arguments, by name: the body's and query's top-level keys. */
  args: Record<string, AuthArg>;
  /** A body whose keys are not known ahead (`updateSession`), taken whole as `input`. */
  openBody: boolean;
  hasBody: boolean;
  hasQuery: boolean;
  /** The 200 response, as the endpoint documents it. */
  result: JsonSchema | undefined;
}

/** The argument an open body is taken as. */
export const OPEN_BODY_ARG = 'input';

/**
 * Endpoints that only make sense over HTTP: `/ok` is a health check and
 * `/error` an HTML page. Path-parameter routes (`/callback/:id`,
 * `/reset-password/:token`) are redirect targets and are left out by rule.
 */
const HTTP_ONLY = new Set(['ok', 'error']);

/**
 * Query arguments that turn a JSON answer into a redirect. A GraphQL caller
 * cannot follow one, so a GET endpoint loses them.
 */
const REDIRECT_ARGS = new Set(['callbackURL', 'errorCallbackURL', 'newUserCallbackURL']);

/** Bodies better-auth opens to the user's own input fields (mirrors its OpenAPI generator). */
const USER_INPUT_PATHS = new Set(['/sign-up/email', '/update-user']);

export interface DescribeOptions {
  /** Overrides the kind an endpoint is given, by name. */
  kinds?: Record<string, OperationKind> | undefined;
}

/**
 * Every endpoint of `auth` a client can call, as an operation. Left out: the
 * server-only ones (no path), the HTTP-only ones, and redirect targets.
 *
 * A GET is a query, unless it takes a `token` in its query string: those
 * (`verifyEmail`, `magicLinkVerify`, `deleteUserCallback`) spend a one-time
 * token, which is a write. Everything else is a mutation.
 */
export function describeOperations(auth: AuthLike, options: DescribeOptions = {}): AuthOperation[] {
  const operations: AuthOperation[] = [];
  for (const [name, value] of Object.entries(auth.api)) {
    if (typeof value !== 'function') continue;
    const endpoint = value as AuthEndpoint;
    const path = endpoint.path;
    const metadata = endpoint.options?.metadata;
    if (!path || path.includes(':') || HTTP_ONLY.has(name)) continue;
    if (metadata?.SERVER_ONLY || metadata?.scope === 'server' || metadata?.isAction === false) continue;

    const rawMethod = endpoint.options?.method ?? 'GET';
    const methods = (Array.isArray(rawMethod) ? rawMethod : [rawMethod]).map((method) => method.toUpperCase());
    const isGet = methods.includes('GET');

    const query = endpoint.options?.query?.toJSONSchema({ io: 'input', unrepresentable: 'any' });
    const body = endpoint.options?.body?.toJSONSchema({ io: 'input', unrepresentable: 'any' });

    const args: Record<string, AuthArg> = {};
    let openBody = false;

    const queryObject = query && asObject(query);
    for (const [key, schema] of Object.entries(queryObject?.properties ?? {})) {
      if (isGet && REDIRECT_ARGS.has(key)) continue;
      args[key] = { schema, required: isRequired(queryObject, key, schema), in: ['query'] };
    }

    if (body) {
      const documented = metadata?.openapi?.requestBody?.content?.['application/json']?.schema;
      const bodyObject = withUserInputFields(withDocumented(asObject(body), documented), path, auth.options);
      const properties = Object.entries(bodyObject?.properties ?? {});
      if (!bodyObject || (properties.length === 0 && bodyObject.additionalProperties)) {
        openBody = true;
        args[OPEN_BODY_ARG] = { schema: {}, required: false, in: ['body'] };
      }
      for (const [key, schema] of properties) {
        const required = isRequired(bodyObject, key, schema);
        const existing = args[key];
        args[key] = existing
          ? { schema, required: required && existing.required, in: ['body', 'query'] }
          : { schema, required, in: ['body'] };
      }
    }

    const consumesToken = isGet && queryObject?.properties?.token !== undefined;
    const kind = options.kinds?.[name] ?? (isGet && !consumesToken ? 'query' : 'mutation');

    operations.push({
      name,
      path,
      methods,
      kind,
      description: metadata?.openapi?.description,
      args,
      openBody,
      hasBody: body !== undefined,
      hasQuery: query !== undefined,
      result: metadata?.openapi?.responses?.['200']?.content?.['application/json']?.schema,
    });
  }
  return operations;
}

/**
 * The models better-auth documents its responses against
 * (`#/components/schemas/User`), as JSON Schema: each table's fields that it
 * returns, named the way its OpenAPI generator names them.
 */
export function describeModels(options: BetterAuthOptions): Record<string, JsonSchema> {
  const models: Record<string, JsonSchema> = {};
  for (const [key, table] of Object.entries(getAuthTables(options))) {
    const properties: Record<string, JsonSchema> = { id: { type: 'string' } };
    const required = ['id'];
    for (const [field, attribute] of Object.entries(table.fields)) {
      if (attribute.returned === false) continue;
      properties[field] = fieldSchema(attribute);
      if (attribute.required === true) required.push(field);
    }
    models[key.charAt(0).toUpperCase() + key.slice(1)] = { type: 'object', properties, required };
  }
  return models;
}

interface FieldAttribute {
  type: string | readonly string[];
  required?: boolean | undefined;
  input?: boolean | undefined;
  returned?: boolean | undefined;
  defaultValue?: unknown;
}

function fieldSchema(field: FieldAttribute): JsonSchema {
  if (Array.isArray(field.type)) return { type: 'string', enum: [...field.type] };
  switch (field.type) {
    case 'date':
      return { type: 'string', format: 'date-time' };
    case 'string[]':
      return { type: 'array', items: { type: 'string' } };
    case 'number[]':
      return { type: 'array', items: { type: 'number' } };
    case 'string':
    case 'number':
    case 'boolean':
      return { type: field.type };
    default:
      return {};
  }
}

/** A body or query schema as one object, folding `allOf` and object unions. */
function asObject(schema: JsonSchema): JsonSchema | undefined {
  if (schema.allOf) return mergeObjects(schema.allOf, false);
  if (schema.anyOf) return mergeObjects(schema.anyOf, true);
  if (schema.oneOf) return mergeObjects(schema.oneOf, true);
  const { types } = typesOf(schema);
  return types.length === 0 || types.includes('object') ? schema : undefined;
}

function isRequired(object: JsonSchema | undefined, key: string, schema: JsonSchema): boolean {
  return (object?.required ?? []).includes(key) && schema.default === undefined && !typesOf(schema).nullable;
}

/**
 * An open body (a zod record, as `updateUser` takes) with the keys its OpenAPI
 * metadata documents. Those keys are what the endpoint reads; the record is
 * only how it lets the user's own fields through.
 */
function withDocumented(object: JsonSchema | undefined, documented: JsonSchema | undefined): JsonSchema | undefined {
  const open = object?.additionalProperties !== undefined && object.additionalProperties !== false;
  if (!object || !open || !documented?.properties) return object;
  const properties = { ...documented.properties, ...(object.properties ?? {}) };
  return { ...object, properties };
}

/**
 * Sign-up and update-user take the user's own fields (`user.additionalFields`
 * and plugins' user fields) through an open record. Name them, as better-auth's
 * OpenAPI generator does, so they are typed arguments. Only sign-up requires
 * the required ones: an update sends what changes.
 */
function withUserInputFields(
  object: JsonSchema | undefined,
  path: string,
  options: BetterAuthOptions,
): JsonSchema | undefined {
  if (!object || !USER_INPUT_PATHS.has(path)) return object;
  let fields: Record<string, FieldAttribute> = { ...(options.user?.additionalFields ?? {}) };
  for (const plugin of options.plugins ?? []) {
    const pluginFields = (plugin.schema as { user?: { fields?: Record<string, FieldAttribute> } } | undefined)?.user
      ?.fields;
    if (pluginFields) fields = { ...fields, ...pluginFields };
  }
  const properties = { ...(object.properties ?? {}) };
  const required = new Set(object.required ?? []);
  for (const [key, field] of Object.entries(fields)) {
    if (field.input === false || properties[key]) continue;
    properties[key] = fieldSchema(field);
    if (path === '/sign-up/email' && field.required === true && field.defaultValue === undefined) required.add(key);
  }
  // Every field is named now, so nothing is left open.
  return { type: 'object', properties, required: [...required] };
}
