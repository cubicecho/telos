import { parseJson } from '@cubicecho/agent-core';
import type { Brief, ProposedTodo } from './telos.ts';

// What an agent is told. The agent's own instructions say what to do with a
// todo; the standing protocol after them says how a reply is read, which is
// the same for every agent: a reply opening with PASS or FAIL is a verdict,
// anything else a report, and new todos come in a fenced `todos` block.

export const STANDING_SYSTEM = `You work one todo on a Telos board, as your instructions above say.

Do the work rather than describing it. When a tool fails, say so plainly and say what you tried;
do not report success you did not have.

Your reply goes on the todo for the next agent and the person to read. When your instructions ask
you to rule on the todo, begin with PASS or FAIL on its own line, then say why; FAIL sends it back,
so name what is not met. Otherwise report what you did and how it can be checked against the
todo's acceptance criteria.

When the todo is better done as several smaller ones, propose them in a fenced block marked
todos, holding a JSON array, after anything else you say:

\`\`\`todos
[
  {
    "title": "imperative, under about ten words",
    "brief": "what to do and what to watch out for",
    "acceptance": "how someone can tell this todo is done",
    "dependsOn": ["exact titles of todos in this list that must finish first"]
  }
]
\`\`\`

The todo then waits until they are done. Order them so none depends on a later one, and use
"dependsOn" only for a real ordering constraint.`;

/**
 * The system prompt for a run: where it is, who the agent is and what it does
 * (its own instructions), then the standing protocol every agent shares.
 *
 * @param brief - What telos said about the run.
 * @param instructions - The agent's own instructions, if it has any.
 * @returns The system prompt.
 */
export function systemPromptFor(brief: Brief, instructions: string | null): string {
  const where = [
    `Project: ${brief.projectName}`,
    brief.projectDescription ? `\n${brief.projectDescription}` : '',
    brief.projectContext ? `\n\n${brief.projectContext}` : '',
  ]
    .join('')
    .trim();
  return [where, instructions, STANDING_SYSTEM]
    .map((layer) => (layer ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * What the agent is asked: the todo, its criteria, and what has been said.
 * `why` is why it came back to this lane — a reviewer's FAIL, or what a person
 * said moving it — and a person's notes come last, as the latest word.
 *
 * @param brief What telos said about the run.
 * @returns The user message.
 */
export function briefPrompt(brief: Brief): string {
  const standing = brief.notes.filter((note) => note !== brief.why);
  return [
    `Todo: ${brief.title}`,
    brief.brief ? `\n\n${brief.brief}` : '',
    brief.acceptance ? `\n\nDone when:\n${brief.acceptance}` : '',
    brief.report ? `\n\nWhat the last agent reported:\n${brief.report}` : '',
    brief.why ? `\n\nWhy this came back:\n${brief.why}` : '',
    standing.length
      ? `\n\nNotes on this todo, to take into account:\n${standing.map((note) => `- ${note}`).join('\n')}`
      : '',
  ]
    .join('')
    .trim();
}

/** A fenced block marked `todos`, anywhere in a reply. */
const TODOS_BLOCK = /```todos[^\S\n]*\n([\s\S]*?)```/;

/**
 * Splits a reply into what the agent said and the todos it proposed. The
 * `todos` block is taken out of what it said, since the todos are written as
 * todos and the JSON is nothing anyone would read back.
 *
 * @param reply - The agent's whole reply.
 * @returns The report without the block, and the todos it held; none when there was no block.
 */
export function readReply(reply: string): { report: string; todos: ProposedTodo[] } {
  const block = TODOS_BLOCK.exec(reply);
  if (block === null) {
    return { report: reply, todos: [] };
  }
  return {
    report: reply.replace(block[0], '').trim(),
    todos: proposedTodos(parseJson<unknown>(block[1])),
  };
}

/**
 * The todos a `todos` block proposes, read forgivingly.
 *
 * @param parsed - What `parseJson` made of the block.
 * @returns The proposals with a title; none when there were none to read.
 */
export function proposedTodos(parsed: unknown): ProposedTodo[] {
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .filter((item) => typeof item.title === 'string' && item.title.trim())
    .map((item) => ({
      title: String(item.title).trim(),
      // kanban_server called it `body`; either is accepted.
      brief: typeof item.brief === 'string' ? item.brief : typeof item.body === 'string' ? item.body : null,
      acceptance: typeof item.acceptance === 'string' ? item.acceptance : null,
      dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.filter((title) => typeof title === 'string') : [],
    }));
}
