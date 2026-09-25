import type { Brief, ProposedTodo } from './telos.ts';

// What an agent is told, ported from kanban_server's runner. Three contracts,
// each with a standing job; a lane's own prompt is added after the job, never
// in place of it, so a board can say "the criteria are in the brief" without
// rewriting what a reviewer is for.

export const WORK_SYSTEM = `You carry out one todo using the tools available to you.

Do the work rather than describing it. When a tool fails, say so plainly and say what you tried;
do not report success you did not have. Finish by stating what you changed and how it can be
checked against the todo's acceptance criteria.`;

export const VERDICT_SYSTEM = `You review one todo that another agent has worked.

Check it against the todo's acceptance criteria and nothing else — not style, not what you would
have done differently. Begin your reply with PASS or FAIL on its own line, then say why in a
sentence or two. FAIL means a criterion is not met; say which one.`;

export const EXPAND_SYSTEM = `You break one todo into the todos that would carry it out.

A todo is one sitting of work with a result someone could check. Split where the work genuinely
changes shape — a migration, then the endpoint that reads it, then the page that calls it — and
not merely to make the list longer. Between three and ten todos is usual; one is a fine answer
for a small piece of work.

Answer with a JSON array and nothing else:

[
  {
    "title": "imperative, under about ten words",
    "brief": "what to do and what to watch out for",
    "acceptance": "how someone can tell this todo is done",
    "dependsOn": ["exact titles of todos in this list that must finish first"]
  }
]

Order the array so a todo never depends on one after it. Use "dependsOn" only for a real
ordering constraint; parallel todos should have none.`;

const JOBS: Record<Brief['contract'], string> = {
  work: WORK_SYSTEM,
  verdict: VERDICT_SYSTEM,
  expand: EXPAND_SYSTEM,
};

/**
 * The system prompt for a run: where it is, who the agent is, then the job and
 * the lane's addendum. The lane speaks last: the agent says who it is, and the
 * lane says what to do.
 *
 * @param brief What telos said about the run.
 * @param identity The agent's own standing instruction, if it has one.
 * @returns The system prompt.
 */
export function systemPromptFor(brief: Brief, identity: string | null): string {
  const where = [
    `Project: ${brief.projectName}`,
    brief.projectDescription ? `\n${brief.projectDescription}` : '',
    brief.projectContext ? `\n\n${brief.projectContext}` : '',
  ]
    .join('')
    .trim();
  return [where, identity, JOBS[brief.contract], brief.lanePrompt]
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

/**
 * The todos an expansion's answer proposes, read forgivingly: a model that says
 * "here you go:" before the JSON has still answered.
 *
 * @param parsed What `parseJson` made of the answer.
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
