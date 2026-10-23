import { parseJson } from '@cubicecho/agent-core';
import type { Assignment, ProposedTodo, RefinedTodo } from './telos.ts';

// What an agent is told. Its system prompt is only what people wrote, broadest
// first: the account's agent instructions (telos's default until the account
// writes its own, resolved by the server), the project, the project's prompt,
// then the prompt the agent was given. What its kind of agent replies with (a
// ruling, a report, a refine or a split) is in that last prompt, and how a
// reply is read back (`readReply` here, `verdictOf` on the server) is the same
// whatever the prompts say.

/**
 * The system prompt for a run: the account's agent instructions, the project
 * (its name, then its description), the project's prompt, and the agent's own
 * prompt, in that order. A layer that is blank is left out. Nothing else is
 * added, so what a run is told is what people wrote, and the run log shows it.
 *
 * @param assignment - What telos said about the run.
 * @param prompt - The body of the agent's prompt, if it has one.
 * @returns The system prompt.
 */
export function systemPromptFor(assignment: Assignment, prompt: string | null): string {
  const project = [`Project: ${assignment.projectName}`, assignment.projectDescription?.trim()]
    .filter(Boolean)
    .join('\n\n');
  return [assignment.agentInstructions, project, assignment.projectPrompt, prompt]
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
