import { parseJson } from '@cubicecho/agent-core';
import type { Assignment, ProposedTodo, RefinedTodo } from './telos.ts';

// What an agent is told. The agent's own instructions say what to do with a
// todo; the standing protocol after them says how a reply is read, which is
// the same for every agent. A reply settles its todo one way: a ruling (PASS
// or FAIL), a report, a refine (the todo rewritten, in a fenced `refine`
// block) or a split (two or more todos, in a fenced `todos` block). The server
// decides what each does to the todo (`finishRun`).

export const STANDING_SYSTEM = `You work one todo on a Telos board, as your instructions above say.

Your instructions say what your job is; nothing below widens it. When a tool fails, say so
plainly and say what you tried; do not report success you did not have.

Your reply goes on the todo for the next agent and the person to read, and it settles the todo in
one of these ways. Use the one your instructions ask for.

A ruling. When your instructions ask you to rule on the todo, begin with PASS or FAIL on its own
line, the bare word with no formatting around it, since that word is how the ruling is read. Then
take the acceptance criteria one at a time (what the brief asks for, when the todo has none): for
each, say met or not met, and quote the evidence you found yourself (a command and what it printed,
a line of a file, what a tool answered). FAIL only on a criterion you can name as not met, with the
evidence that shows it; one you had no way to check is not met, and the evidence is what you tried.
FAIL sends the todo back, and those lines are what the next agent works from.

A report. When you do the work, first plan it: a short checklist of what you will change and how
you will check each acceptance criterion (or what the brief asks for, when the todo has none).
Before you answer, check every criterion yourself. Then end your report with these three sections:

## Changes
What you changed, and where.

## Verification
Each acceptance criterion, what you ran or looked at to check it, and what that showed.

## Open questions
What you were unsure of, could not check or left undone; "None." when there is nothing.

A refine. When your job is to make the todo ready for someone else to do and it is one piece of
work, rewrite it in a fenced block marked refine, holding a JSON object, after anything else you
say. A field you leave out stays as it is:

\`\`\`refine
{
  "title": "imperative, under about ten words",
  "brief": "what to do, where, and what to watch out for",
  "acceptance": "- one line per thing someone can check to tell this todo is done"
}
\`\`\`

A split. When the todo is genuinely several pieces of work, propose two or more todos in a fenced
block marked todos, holding a JSON array, after anything else you say:

\`\`\`todos
[
  {
    "title": "imperative, under about ten words",
    "brief": "what to do and what to watch out for",
    "acceptance": "- one line per thing someone can check to tell this todo is done",
    "dependsOn": ["exact titles of todos in this list that must finish first"]
  }
]
\`\`\`

The todo is then done when they all are. Order them so none depends on a later one, and use
"dependsOn" only for a real ordering constraint.

Never both refine and split: a reply with both fails. You cannot edit, move or finish this todo
with tools; what your reply says is what happens to it.`;

/** What heads the project prompt in a run's system prompt. */
export const PROJECT_PROMPT_HEADING = "This project's instructions, for every agent working its todos:";

/**
 * The system prompt for a run: where it is, what its project asks of every
 * agent working there (the project prompt, a person's own), who the agent is
 * and what it does (its own instructions), then the standing protocol every
 * agent shares. The project prompt comes before the agent's instructions, so
 * those sit right above the protocol that points back at them.
 *
 * @param assignment - What telos said about the run.
 * @param instructions - The agent's own instructions, if it has any.
 * @returns The system prompt.
 */
export function systemPromptFor(assignment: Assignment, instructions: string | null): string {
  const where = [
    `Project: ${assignment.projectName}`,
    assignment.projectDescription ? `\n${assignment.projectDescription}` : '',
    assignment.projectContext ? `\n\n${assignment.projectContext}` : '',
  ]
    .join('')
    .trim();
  const projectPrompt = assignment.projectPrompt?.trim()
    ? `${PROJECT_PROMPT_HEADING}\n${assignment.projectPrompt.trim()}`
    : null;
  return [where, projectPrompt, instructions, STANDING_SYSTEM]
    .map((layer) => (layer ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * What a reviewer is told in place of the report: the work is what it rules
 * on. LLM judges lean toward the account in front of them, and toward their
 * own model's writing, so telos leaves the worker's report out (`reviews`).
 */
export const REVIEW_NOTE = `You are ruling on the work itself. The report of the agent that did it is left out on purpose:
check what is there, with your tools and in what has been made for it, not what anyone says was done.`;

/**
 * What the agent is asked: the todo, its criteria, and what has been said.
 * `why` is why it came back to this lane — a reviewer's FAIL, or what a person
 * said moving it — and a person's notes come last, as the latest word. A lane
 * that reviews work is not sent the report (telos leaves it out), and is told
 * why; every lane is told what has been made for the todo, as where to look.
 *
 * @param assignment What telos said about the run.
 * @returns The user message.
 */
export function assignmentPrompt(assignment: Assignment): string {
  const standing = assignment.notes.filter((note) => note !== assignment.why);
  const ruling = assignment.ruling !== assignment.why ? assignment.ruling : null;
  const made = assignment.artifacts.map(
    (artifact) => `- ${artifact.action} ${artifact.location}${artifact.title ? ` (${artifact.title})` : ''}`,
  );
  return [
    `Todo: ${assignment.title}`,
    assignment.brief ? `\n\n${assignment.brief}` : '',
    assignment.acceptance ? `\n\nDone when:\n${assignment.acceptance}` : '',
    assignment.reviews ? `\n\n${REVIEW_NOTE}` : '',
    assignment.report ? `\n\nWhat the last agent reported:\n${assignment.report}` : '',
    made.length ? `\n\nWhat has been made for this todo, the newest first:\n${made.join('\n')}` : '',
    ruling ? `\n\nThe last ruling on this todo:\n${ruling}` : '',
    assignment.why ? `\n\nWhy this came back:\n${assignment.why}` : '',
    standing.length
      ? `\n\nNotes on this todo, to take into account:\n${standing.map((note) => `- ${note}`).join('\n')}`
      : '',
  ]
    .join('')
    .trim();
}

/** A fenced block marked `todos`, anywhere in a reply. */
const TODOS_BLOCK = /```todos[^\S\n]*\n([\s\S]*?)```/;
/** A fenced block marked `refine`, anywhere in a reply. */
const REFINE_BLOCK = /```refine[^\S\n]*\n([\s\S]*?)```/;

/** What a reply says, read apart. */
export interface Reply {
  /** What the agent said, without its blocks. */
  report: string;
  /** The todos a `todos` block proposed; none without one. */
  todos: ProposedTodo[];
  /** The todo as a `refine` block rewrote it; null without one. */
  refine: RefinedTodo | null;
}

/**
 * Splits a reply into what the agent said, the todos it proposed and the todo
 * as it rewrote it. The blocks are taken out of what it said, since what they
 * hold is written to the board and the JSON is nothing anyone would read back.
 * What to make of a reply holding both is the server's to say.
 *
 * @param reply - The agent's whole reply.
 * @returns The report without the blocks, and what they held.
 */
export function readReply(reply: string): Reply {
  const todosBlock = TODOS_BLOCK.exec(reply);
  const refineBlock = REFINE_BLOCK.exec(reply);
  const report = [todosBlock, refineBlock]
    .reduce((text, block) => (block === null ? text : text.replace(block[0], '')), reply)
    .trim();
  return {
    report: todosBlock === null && refineBlock === null ? reply : report,
    todos: todosBlock === null ? [] : proposedTodos(parseJson<unknown>(todosBlock[1])),
    refine: refineBlock === null ? null : refinedTodo(parseJson<unknown>(refineBlock[1])),
  };
}

/**
 * The todo a `refine` block rewrites, read forgivingly: the fields it gave as
 * text, and nothing else.
 *
 * @param parsed - What `parseJson` made of the block.
 * @returns The rewrite; null when the block held no object.
 */
export function refinedTodo(parsed: unknown): RefinedTodo | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const item = parsed as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  return {
    title: text(item.title),
    brief: text(item.brief) ?? text(item.body),
    acceptance: text(item.acceptance),
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
