import * as dbSchema from '@telos/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { extendSchema, GraphQLError, type GraphQLObjectType, type GraphQLSchema, parse } from 'graphql';
import { requireAi } from '../ai-gate.ts';
import { type Context, isAiActor } from '../context.ts';
import { requireAuth } from './auth.ts';
import { requireText } from './requests.ts';

// Rewriting a note and taking one away. Generated CRUD adds notes and stops
// there (tenancy.ts), because whether a note may change depends on who is
// asking and who wrote it:
//
// - A report or a verdict is what a run said, and the next agent may already
//   have been told it. Nobody changes one.
// - A plain note is rewritten only by whoever signed it: a person their own,
//   an API key the ones under its key, a run the ones it left.
// - A person may also take any plain note off their own board.
//
// A note the caller cannot see is NOT_FOUND, as everywhere else. The thread is
// read when a run is claimed (`assignmentFor`), so an edit reaches the runs that
// start after it and no earlier one.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyRow = any;

const PLAIN_NOTE = 'note';

const NOTES_SDL = parse(`
  extend type Mutation {
    """
    Rewrites a note. Only whoever signed it may, and only a plain note: a
    report or a verdict stays as the run wrote it. The note records when it was
    edited. Runs that start afterwards read the new text; earlier ones do not.
    """
    editTodoNote(id: ID!, body: String!): TodoNote!
    """
    Removes a note from its todo's thread. Whoever signed it may, and a person
    may remove any plain note on their own board. A report or a verdict stays.
    """
    deleteTodoNote(id: ID!): TodoNote!
  }
`);

function notFound(): GraphQLError {
  return new GraphQLError('Note not found', { extensions: { code: 'NOT_FOUND' } });
}

function forbidden(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'FORBIDDEN' } });
}

/**
 * A note the caller may see, or NOT_FOUND. For a person that is any note of
 * theirs. For AI it is narrower, as in tenancy.ts: the note's todo must be one
 * AI can see, and AI must be on for the account.
 *
 * @param context - The request.
 * @param id - The note.
 * @returns The note's row.
 */
async function loadVisibleNote(context: Context, id: string): Promise<AnyRow> {
  const ai = isAiActor(context);
  const userId = ai ? await requireAi(context) : requireAuth(context);
  const owned = and(eq(dbSchema.todoNotes.id, id), eq(dbSchema.todoNotes.userId, userId));
  const [row] = await (context.db as AnyRow)
    .select({ note: dbSchema.todoNotes })
    .from(dbSchema.todoNotes)
    .innerJoin(dbSchema.todos, eq(dbSchema.todos.id, dbSchema.todoNotes.todoId))
    .innerJoin(dbSchema.projects, eq(dbSchema.projects.id, dbSchema.todos.projectId))
    .where(
      ai
        ? and(
            owned,
            eq(dbSchema.todos.aiIgnored, false),
            isNull(dbSchema.todos.archivedAt),
            eq(dbSchema.projects.aiEnabled, true),
          )
        : owned,
    );
  if (!row) {
    throw notFound();
  }
  return row.note;
}

/** Whether the caller is who signed `note`. */
function signedByCaller(context: Context, note: AnyRow): boolean {
  const { actor } = context;
  if (note.actorKind !== actor.kind) {
    return false;
  }
  if (actor.kind === 'user') {
    return true;
  }
  if (actor.kind === 'apiKey') {
    return actor.keyId != null && note.actorKeyId === actor.keyId;
  }
  return actor.kind === 'agent' && actor.runId != null && note.runId === actor.runId;
}

/** Refuses a report or a verdict, which nobody changes. */
function assertPlainNote(note: AnyRow): void {
  if (note.kind === PLAIN_NOTE) {
    return;
  }
  throw forbidden(`A ${note.kind} is what a run said, and it stays as written. Add a note to correct it.`);
}

export function applyNotesExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(schema, NOTES_SDL);
  const mutations = (extendedSchema.getType('Mutation') as GraphQLObjectType).getFields();

  mutations.editTodoNote.resolve = async (_parent: unknown, args: { id: string; body: string }, context: Context) => {
    const note = await loadVisibleNote(context, args.id);
    assertPlainNote(note);
    if (signedByCaller(context, note) === false) {
      throw forbidden(
        isAiActor(context)
          ? 'You can rewrite only the notes you signed. Add a note of your own instead.'
          : 'Only whoever wrote a note can rewrite it. Add a note of your own, or delete this one.',
      );
    }
    const body = requireText(args.body, 'body');
    // Saving a note as it already reads is not an edit.
    if (body === note.body) {
      return note;
    }
    const [edited] = await (context.db as AnyRow)
      .update(dbSchema.todoNotes)
      .set({ body, editedAt: new Date() })
      .where(eq(dbSchema.todoNotes.id, note.id))
      .returning();
    if (!edited) {
      throw notFound();
    }
    return edited;
  };

  mutations.deleteTodoNote.resolve = async (_parent: unknown, args: { id: string }, context: Context) => {
    const note = await loadVisibleNote(context, args.id);
    assertPlainNote(note);
    // The board is the person's, so they may clear any plain note off it.
    if (context.actor.kind !== 'user' && signedByCaller(context, note) === false) {
      throw forbidden('You can delete only the notes you signed.');
    }
    const [removed] = await (context.db as AnyRow)
      .delete(dbSchema.todoNotes)
      .where(eq(dbSchema.todoNotes.id, note.id))
      .returning();
    if (!removed) {
      throw notFound();
    }
    return removed;
  };

  return extendedSchema;
}
