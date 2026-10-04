import * as dbSchema from '@telos/db/schema';
import { and, eq } from 'drizzle-orm';
import { extendSchema, GraphQLError, type GraphQLObjectType, type GraphQLSchema, parse } from 'graphql';
import { requireAi } from '../ai-gate.ts';
import type { Context } from '../context.ts';
import { loadAiTodo, requireText } from './requests.ts';

// Recording an artifact from outside a run. A todo's run reports what it
// made through `finishRun`, where the runner has checked each location against
// what the run's tools did. Work done elsewhere, by an MCP client holding an
// API key, has no such witness: the client says where the thing is and the
// board takes its word. So these rows carry their own source, `client`, and
// are signed as the key that recorded them, the way a note is.
//
// Applied only when the instance has AI on.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyRow = any;

const ARTIFACTS_SDL = parse(`
  extend type Mutation {
    """
    Records something made for a todo outside any run: where it is and what to
    call it. The board keeps the location, never a copy. Signed as whoever is
    calling, and listed as a client's word, which nothing checked. Recording
    the same location on the same todo again updates what was recorded.
    """
    recordArtifact(todoId: ID!, location: String!, label: String!, mediaType: String, sizeBytes: Int): Artifact!
  }
`);

/** The most of a location kept: a long URL, not a document. */
const MAX_LOCATION = 2000;
const MAX_LABEL = 200;
const MAX_MEDIA_TYPE = 200;
/** The scheme the runner files a run's notes under. Not a client's to claim. */
const NOTE_LOCATION = 'telos:note/';

function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
}

/**
 * `value` trimmed, or BAD_USER_INPUT when it is empty or longer than `limit`.
 *
 * @param value - What the caller sent.
 * @param field - The argument's name, for the message.
 * @param limit - The most characters kept.
 * @returns The trimmed text.
 */
function requireShortText(value: string, field: string, limit: number): string {
  const text = requireText(value, field);
  if (text.length > limit) {
    throw badInput(`${field} is ${text.length} characters. Keep it to ${limit}.`);
  }
  return text;
}

interface RecordArtifactArgs {
  todoId: string;
  location: string;
  label: string;
  mediaType?: string | null;
  sizeBytes?: number | null;
}

export function applyArtifactsExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(schema, ARTIFACTS_SDL);
  const mutations = (extendedSchema.getType('Mutation') as GraphQLObjectType).getFields();

  mutations.recordArtifact.resolve = async (_parent: unknown, args: RecordArtifactArgs, context: Context) => {
    const userId = await requireAi(context);
    const { actor } = context;
    if (actor.kind === 'agent') {
      // A run's artifacts are held against what its tools did, by the runner.
      throw new GraphQLError(
        'A run records what it made with its own record_artifact tool, which the runner checks. This one is for work done outside a run.',
        { extensions: { code: 'FORBIDDEN' } },
      );
    }
    const todo = await loadAiTodo(context, userId, args.todoId);
    const location = requireShortText(args.location, 'location', MAX_LOCATION);
    if (location.startsWith(NOTE_LOCATION)) {
      throw badInput(`A location under ${NOTE_LOCATION} is a note on the todo. Use add_todo_note to leave one.`);
    }
    const label = requireShortText(args.label, 'label', MAX_LABEL);
    const mediaType = args.mediaType?.trim() ? requireShortText(args.mediaType, 'mediaType', MAX_MEDIA_TYPE) : null;
    const sizeBytes = args.sizeBytes ?? null;
    if (sizeBytes !== null && sizeBytes < 0) {
      throw badInput('sizeBytes cannot be negative. Leave it out when the size is not known.');
    }
    const signer = {
      actorKind: actor.kind === 'apiKey' ? ('apiKey' as const) : ('user' as const),
      actorKeyId: actor.keyId ?? null,
    };

    return (context.db as AnyRow).transaction(async (tx: AnyRow) => {
      // Said twice, it is one artifact: a client that retries does not list
      // the same file again.
      const [existing] = await tx
        .select({ id: dbSchema.artifacts.id })
        .from(dbSchema.artifacts)
        .where(
          and(
            eq(dbSchema.artifacts.todoId, todo.id),
            eq(dbSchema.artifacts.location, location),
            eq(dbSchema.artifacts.source, dbSchema.CLIENT_ARTIFACT_SOURCE),
          ),
        )
        .for('update');
      if (existing) {
        const [updated] = await tx
          .update(dbSchema.artifacts)
          .set({ title: label, mediaType, sizeBytes, action: 'updated', ...signer })
          .where(eq(dbSchema.artifacts.id, existing.id))
          .returning();
        return updated;
      }
      const [recorded] = await tx
        .insert(dbSchema.artifacts)
        .values({
          userId,
          projectId: todo.projectId,
          todoId: todo.id,
          location,
          source: dbSchema.CLIENT_ARTIFACT_SOURCE,
          title: label,
          mediaType,
          sizeBytes,
          ...signer,
        })
        .returning();
      return recorded;
    });
  };

  return extendedSchema;
}
