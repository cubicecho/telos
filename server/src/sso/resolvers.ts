import type { DB } from '@telos/db';
import * as dbSchema from '@telos/db/schema';
import { extendSchema, GraphQLError, type GraphQLSchema, parse } from 'graphql';
import type { MutationResolvers, QueryResolvers } from '../../__generated__/resolvers.ts';
import { oidcRedirectUri } from '../core/config.ts';
import type { Context } from '../core/context.ts';
import { SsoSourceEnum, withEnums } from '../core/enums.ts';
import { conflict, forbidden } from '../core/errors.ts';
import { attachResolvers } from '../graphql/attach-resolvers.ts';
import { isAdmin } from '../instance/settings.ts';
import { PairingError, pair, unpair } from './pairing.ts';
import { effectiveOidc, type OidcSource } from './settings.ts';

// Pairing the instance with an OIDC provider from the app (sso/pairing.ts):
// paste the setup URL the provider gave you, and its button appears on the
// login page without a restart.
//
// Who may pair: an admin, or anyone at all while the instance is brand new (no
// accounts yet), so whoever installs Telos can set sign-in up from
// the login page before there is an admin to ask. The first account to sign in
// becomes the admin (instance/settings.ts claimFirstAdmin). Once anyone has an account,
// a stranger could otherwise point sign-in at a provider of their own and sign
// in as any existing address, so only an admin may.
//
// A provider set in the environment (OIDC_ISSUER) wins, and cannot be changed
// from here.

const SSO_SETUP_SDL = parse(`
  "How sign-in through an OIDC provider is set up, and whether the caller may change it."
  type SsoSetup {
    source: SsoSource!
    "The provider's issuer URL. Only for a caller who may pair."
    issuer: String
    "What the login page's button calls the provider."
    name: String
    "Whether the caller may pair a provider (or unpair the paired one)."
    canPair: Boolean!
    "The redirect URI to register with a provider by hand, for an OIDC_ISSUER setup."
    redirectUri: String!
  }

  extend type Query {
    "Readable before signing in, so a new instance's login page can offer to set sign-in up."
    ssoSetup: SsoSetup!
  }

  extend type Mutation {
    "Pairs with the provider a setup URL names (\`<issuer>#setup=<token>&name=<name>\`). An admin, or anyone on a new instance."
    pairSso(setupUrl: String!): SsoSetup!
    "Deletes the paired provider's client and stops offering it on the login page. An admin, or anyone on a new instance."
    unpairSso: SsoSetup!
  }
`);

/** Whether anyone has an account yet. */
async function hasUsers(db: DB): Promise<boolean> {
  const [row] = await db.select({ id: dbSchema.users.id }).from(dbSchema.users).limit(1);
  return Boolean(row);
}

/**
 * Whether the caller may pair or unpair a provider, given where the current
 * one comes from.
 *
 * @param ctx The request.
 * @param source Where the provider in use comes from.
 * @returns The answer.
 */
export async function canPairSso(ctx: Context, source: OidcSource): Promise<boolean> {
  if (source === 'env') return false;
  if (ctx.actor.kind === 'user' && ctx.userId && (await isAdmin(ctx.db, ctx.userId))) return true;
  return !(await hasUsers(ctx.db));
}

async function setup(ctx: Context) {
  const { config, source } = await effectiveOidc(ctx.db);
  const canPair = await canPairSso(ctx, source);
  return {
    source,
    issuer: canPair ? (config?.issuer ?? null) : null,
    name: config?.name ?? null,
    canPair,
    redirectUri: oidcRedirectUri(),
  };
}

/** The refusal for a caller who may not pair, by where the provider comes from. */
async function requirePairing(ctx: Context): Promise<OidcSource> {
  const { source } = await effectiveOidc(ctx.db);
  if (source === 'env') {
    throw forbidden("Sign-in is set by OIDC_ISSUER in the server's environment. Change it there.");
  }
  if (!(await canPairSso(ctx, source))) {
    throw forbidden('Only an admin can change how people sign in.');
  }
  return source;
}

/** A pairing failure as an API error, with its reason for the app. */
function pairingError(error: unknown): unknown {
  if (!(error instanceof PairingError)) return error;
  const code = error.reason === 'RATE_LIMITED' ? 'TOO_MANY_REQUESTS' : 'BAD_USER_INPUT';
  return new GraphQLError(error.message, { extensions: { code, reason: error.reason } });
}

export function applySsoSetupExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(withEnums(schema, [SsoSourceEnum]), SSO_SETUP_SDL);
  const queries: QueryResolvers = {};
  const mutations: MutationResolvers = {};

  queries.ssoSetup = (_parent, _args, context) => setup(context);

  mutations.pairSso = async (_parent, args, context) => {
    const source = await requirePairing(context);
    if (source === 'paired') {
      throw conflict('Telos is already paired with a provider. Disconnect it first.');
    }
    try {
      await pair(context.db, args.setupUrl);
    } catch (error) {
      throw pairingError(error);
    }
    await context.authHost.rebuild();
    return setup(context);
  };

  mutations.unpairSso = async (_parent, _args, context) => {
    await requirePairing(context);
    await unpair(context.db);
    await context.authHost.rebuild();
    return setup(context);
  };

  return attachResolvers(extendedSchema, { Query: queries, Mutation: mutations });
}
