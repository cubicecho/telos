import * as dbSchema from '@telos/db/schema';
import { and, eq } from 'drizzle-orm';
import { extendSchema, GraphQLError, type GraphQLObjectType, type GraphQLSchema, parse } from 'graphql';
import type { Context } from '../context.ts';
import { joinPrompts } from '../lane-presets.ts';
import { requireAuth } from './auth.ts';

// Lane presets: a station's contract, prompt and limits, kept on the account so
// many lanes can follow one. Listing, making, editing and deleting a preset is
// generated CRUD, and a lane follows one by a generated write of `presetId`;
// the database keeps the lane in step (see the lane_presets migration). What
// is here is the one move that writes both at once.
//
// Applied only when the instance has AI on.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyRow = any;

const LANE_PRESETS_SDL = parse(`
  extend type Mutation {
    """
    Makes a preset of a lane's contract, prompt, WIP limit and attempts, and
    has the lane follow it. \`id\` is the new preset's, when the caller minted one.
    """
    saveLaneAsPreset(laneId: ID!, name: String!, id: ID): LanePreset!
  }
`);

const MAX_NAME = 100;

export function applyLanePresetsExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(schema, LANE_PRESETS_SDL);
  const mutations = (extendedSchema.getType('Mutation') as GraphQLObjectType).getFields();

  mutations.saveLaneAsPreset.resolve = async (
    _parent: unknown,
    args: { laneId: string; name: string; id?: string | null },
    context: Context,
  ) => {
    const userId = requireAuth(context);
    const name = args.name.trim();
    if (name === '' || name.length > MAX_NAME) {
      throw new GraphQLError(`Name the preset, in ${MAX_NAME} characters or fewer.`, {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    return (context.db as AnyRow).transaction(async (tx: AnyRow) => {
      const [lane] = await tx
        .select()
        .from(dbSchema.lanes)
        .where(and(eq(dbSchema.lanes.id, args.laneId), eq(dbSchema.lanes.userId, userId)))
        .for('update');
      if (!lane) {
        throw new GraphQLError('Lane not found', { extensions: { code: 'NOT_FOUND' } });
      }
      const [taken] = await tx
        .select({ id: dbSchema.lanePresets.id })
        .from(dbSchema.lanePresets)
        .where(and(eq(dbSchema.lanePresets.userId, userId), eq(dbSchema.lanePresets.name, name)));
      if (taken) {
        throw new GraphQLError(`You already have a preset called "${name}".`, { extensions: { code: 'CONFLICT' } });
      }
      // A lane already following a preset is saved as what it is told now:
      // that preset's prompt and its own, as one.
      const [followed] = lane.presetId
        ? await tx
            .select({ prompt: dbSchema.lanePresets.prompt })
            .from(dbSchema.lanePresets)
            .where(eq(dbSchema.lanePresets.id, lane.presetId))
        : [];
      const [preset] = await tx
        .insert(dbSchema.lanePresets)
        .values({
          ...(args.id ? { id: args.id } : {}),
          userId,
          name,
          contract: lane.contract,
          prompt: joinPrompts(followed?.prompt, lane.prompt),
          wipLimit: lane.wipLimit,
          maxAttempts: lane.maxAttempts,
        })
        .returning();
      // Everything the lane said is the preset's now, so it adds nothing.
      await tx
        .update(dbSchema.lanes)
        .set({ presetId: preset.id, presetOverrides: [], prompt: null, updatedAt: new Date() })
        .where(eq(dbSchema.lanes.id, lane.id));
      return preset;
    });
  };

  return extendedSchema;
}
