import type OpenAI from 'openai';

// Asking a person. An agent that is missing something it cannot find out for
// itself calls `ask_person` rather than guessing or failing. The runner ends
// the run there and reports the question (status `asked`); telos puts it on the
// todo's thread and holds the todo until a person answers. Pure: nothing here
// talks to telos.

export const ASK_PERSON = 'ask_person';

export const ASK_PERSON_DEFINITION: OpenAI.ChatCompletionTool = {
  type: 'function',
  function: {
    name: ASK_PERSON,
    description:
      'Ask the person who owns this todo something only they can answer, and stop. Use it when the ' +
      'todo cannot be done well without a decision or a fact you cannot find with your tools: a ' +
      'choice between approaches the brief leaves open, a missing credential or address, a ' +
      'contradiction in the acceptance criteria. This run ends when you call it, and nothing you ' +
      'would have said after it is kept; the todo waits until the person answers, and the next ' +
      'run is shown your question and their answer. Do not use it for what you could check yourself.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description:
            'The question, standing on its own: what you need, why, and the options you see if there are any.',
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
};

/** What the agent is told when its question has been taken. The run stops right after. */
export const ASKED_REPLY = 'Asked. This run ends here; the todo waits for the answer.';

/**
 * The question an `ask_person` call carries, or null when it carries none.
 *
 * @param args - The call's arguments.
 * @returns The question, trimmed.
 */
export function questionOf(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const question = (args as Record<string, unknown>).question;
  return typeof question === 'string' && question.trim() ? question.trim() : null;
}
