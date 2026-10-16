import { isAPIError } from 'better-auth/api';
import { GraphQLError, type GraphQLResolveInfo } from 'graphql';
import { type JsonSchema, typesOf } from './json-schema.ts';
import { type AuthEndpoint, type AuthLike, type AuthOperation, OPEN_BODY_ARG } from './operations.ts';

// One resolver per operation: put each argument where its endpoint reads it,
// call the endpoint with the request's headers, hand back what it returns.
// better-auth does its own checks (session, fresh session, ownership), so a
// resolver adds none; `before` is where a host adds its own.

export interface OperationCall<TContext> {
  operation: AuthOperation;
  args: Record<string, unknown>;
  context: TContext;
  info: GraphQLResolveInfo;
  /** What the endpoint will be sent as its body, from `args`. A hook may change it. */
  body: Record<string, unknown>;
  /** What the endpoint will be sent as its query, from `args`. A hook may change it. */
  query: Record<string, unknown>;
}

/**
 * Wraps one operation's call: change `call.body` or `call.query` before
 * `next()`, change what it returns after, or answer without calling it.
 */
export type Around<TContext> = (call: OperationCall<TContext>, next: () => Promise<unknown>) => Promise<unknown>;

export interface ResolverOptions<TContext> {
  /** The auth instance a request is served by. Defaults to the one the schema was built from. */
  auth?: ((context: TContext) => AuthLike) | undefined;
  /** The request's headers: where better-auth finds the session (cookie or bearer). */
  headers: (context: TContext) => Headers;
  /**
   * Runs before every call. Throw to refuse it: rate limiting, captcha, or
   * rules of the host's own about who may call what.
   */
  before?: ((call: OperationCall<TContext>) => void | Promise<void>) | undefined;
  /**
   * The headers an endpoint set: `set-cookie` for a cookie session,
   * `set-auth-token` from the bearer plugin. A host serving cookies forwards
   * them to its HTTP response here.
   */
  onResponseHeaders?: ((headers: Headers, call: OperationCall<TContext>) => void) | undefined;
  /** Turns what an endpoint threw into what the caller is told. Defaults to `toGraphQLError`. */
  mapError?: ((error: unknown, call: OperationCall<TContext>) => unknown) | undefined;
}

export type AuthResolver<TContext> = (
  parent: unknown,
  args: Record<string, unknown>,
  context: TContext,
  info: GraphQLResolveInfo,
) => Promise<unknown>;

export function createResolver<TContext>(
  built: AuthLike,
  operation: AuthOperation,
  options: ResolverOptions<TContext>,
  around?: Around<TContext>,
): AuthResolver<TContext> {
  return async (_parent, args, context, info) => {
    const body: Record<string, unknown> = {};
    const query: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(args)) {
      const arg = operation.args[name];
      if (!arg || value === undefined) continue;
      if (operation.openBody && name === OPEN_BODY_ARG) {
        if (value && typeof value === 'object') Object.assign(body, value);
        continue;
      }
      const cleaned = withoutNulls(value, arg.schema);
      if (cleaned === undefined) continue;
      if (arg.in.includes('body')) body[name] = cleaned;
      if (arg.in.includes('query')) query[name] = cleaned;
    }

    const call: OperationCall<TContext> = { operation, args, context, info, body, query };
    await options.before?.(call);

    const send = async (): Promise<unknown> => {
      const auth = options.auth?.(context) ?? built;
      const endpoint = (auth.api as Record<string, AuthEndpoint>)[operation.name];
      if (!endpoint) throw new Error(`better-auth-graphql: auth.api.${operation.name} is gone`);
      try {
        const { headers, response } = await endpoint({
          ...(operation.hasBody ? { body: call.body } : {}),
          ...(operation.hasQuery ? { query: call.query } : {}),
          headers: options.headers(context),
          returnHeaders: true,
        });
        if (headers) options.onResponseHeaders?.(headers, call);
        // As the REST route would send it: a Date as its ISO string, whatever
        // the host's DateTime scalar does with one.
        return response === undefined || response === null ? null : JSON.parse(JSON.stringify(response));
      } catch (error) {
        throw (options.mapError ?? toGraphQLError)(error, call);
      }
    };
    return (around ? await around(call, send) : await send()) ?? null;
  };
}

/**
 * GraphQL has one null where zod has two ways to be absent: a null for a
 * field that cannot be null is read as "not given". One that can be null
 * (`image` on `updateUser`) keeps it, which is how it is cleared.
 */
function withoutNulls(value: unknown, schema: JsonSchema): unknown {
  if (value === null) return typesOf(schema).nullable ? null : undefined;
  if (Array.isArray(value)) return value.map((item) => withoutNulls(item, schema.items ?? {}));
  if (typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    const cleaned = withoutNulls(inner, schema.properties?.[key] ?? {});
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

/** better-auth's HTTP statuses, as GraphQL error codes. */
const CODES: Record<number, string> = {
  400: 'BAD_USER_INPUT',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'BAD_USER_INPUT',
  429: 'TOO_MANY_REQUESTS',
};

/**
 * What an endpoint threw, as a GraphQL error. An `APIError` keeps its message,
 * gets a code from its status, and carries better-auth's own code as
 * `authCode` (`INVALID_EMAIL_OR_PASSWORD`, `INVALID_TOKEN`), which is the one
 * a client should branch on. A redirect is how some endpoints fail (a spent
 * magic link sends the browser to `?error=INVALID_TOKEN`), so the code in its
 * URL is read back out. Anything else is rethrown for the server to mask.
 */
export function toGraphQLError(error: unknown): unknown {
  if (!isAPIError(error)) return error;
  const status = error.statusCode;
  if (status >= 300 && status < 400) {
    const location = headerOf(error.headers, 'location');
    const authCode = location ? redirectError(location) : undefined;
    return new GraphQLError(authCode ? humanize(authCode) : 'The request could not be completed', {
      extensions: { code: 'BAD_USER_INPUT', ...(authCode ? { authCode } : {}) },
    });
  }
  const code = CODES[status];
  if (!code) return error;
  const body = error.body as { code?: unknown; message?: unknown } | undefined;
  const message = typeof body?.message === 'string' && body.message ? body.message : error.message;
  return new GraphQLError(message, {
    extensions: { code, ...(typeof body?.code === 'string' ? { authCode: body.code } : {}) },
  });
}

function headerOf(headers: unknown, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  if (headers && typeof headers === 'object') {
    const value = (headers as Record<string, unknown>)[name];
    return typeof value === 'string' ? value : null;
  }
  return null;
}

function redirectError(location: string): string | undefined {
  try {
    return new URL(location, 'http://redirect.invalid').searchParams.get('error')?.toUpperCase() || undefined;
  } catch {
    return undefined;
  }
}

/** `INVALID_TOKEN` -> `Invalid token`. */
function humanize(code: string): string {
  const words = code.toLowerCase().replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
