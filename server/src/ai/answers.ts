import * as dbSchema from '@telos/db/schema';
import { extendSchema, type GraphQLSchema, parse } from 'graphql';
import type { MutationResolvers } from '../../__generated__/resolvers.ts';
import { requireAuth } from '../auth/resolvers.ts';
import { type Context, isAiActor } from '../core/context.ts';
import { badInput, forbidden } from '../core/errors.ts';
import { loadAiTodo, loadOwnedTodo } from '../core/owned.ts';
import { attachResolvers } from '../graphql/attach-resolvers.ts';
import { findQuestions } from '../todos/questions.ts';
import { requireAi } from './gate.ts';
import { requireText } from './requests.ts';

// Answering a question a run asked (todos/questions.ts has the rule). Any note
// a person adds after the question answers it; `answerTodo` is the explicit
// way, for a client that wants one, and refuses when nothing is waiting.
//
// Applied only when the instance has AI on.

const ANSWERS_SDL = parse(`
  extend type Mutation {
    """
    Answers the question an agent asked on a todo, as a note on its thread. The
    todo is then ready for its lane's agent again, which reads the question and
    the answer. Any note a person adds after the question answers it too. A run
    cannot answer one.
    """
    answerTodo(todoId: ID!, text: String!): TodoNote!
  }
`);

export function applyAnswersExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(schema, ANSWERS_SDL);
  const mutations: MutationResolvers = {};

  mutations.answerTodo = async (_parent, args, context: Context) => {
    const { actor } = context;
    if (actor.kind === 'agent') {
      throw forbidden('A run cannot answer a question: only a person can. Say what you need in your reply instead.');
    }
    // A person answers on any todo of theirs; an MCP client only where AI may see it.
    const ai = isAiActor(context);
    const userId = ai ? await requireAi(context) : requireAuth(context);
    const todo = ai ? await loadAiTodo(context, args.todoId) : await loadOwnedTodo(context, args.todoId);
    const text = requireText(args.text, 'text');
    if (!(await findQuestions(context.db, [todo.id])).has(todo.id)) {
      throw badInput('Nothing on this todo is waiting for an answer. Add a note instead.');
    }
    const [note] = await context.db
      .insert(dbSchema.todoNotes)
      .values({
        userId,
        todoId: todo.id,
        kind: 'note',
        body: text,
        actorKind: actor.kind === 'apiKey' ? 'apiKey' : 'user',
        actorKeyId: actor.keyId ?? null,
      })
      .returning();
    return note;
  };

  return attachResolvers(extendedSchema, { Mutation: mutations });
}
