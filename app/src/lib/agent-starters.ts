import { type AgentDraft, toAgentDraft } from './agents';

// The four agents kanban_server came with (refiner, planner, worker,
// reviewer), as starting text for a new agent. An agent's instructions are all
// it is told about its job: how its reply is read (PASS or FAIL, a report, a
// `todos` block) is the runner's standing protocol and is sent whatever the
// agent says (runner/src/prompts.ts, runner/src/drafts.ts). What a starter
// leaves out is left blank, inheriting the agent defaults: above all the
// endpoint and the model, which are the only things someone has to add.

export interface AgentStarter {
  /** Its key. */
  id: 'refiner' | 'planner' | 'worker' | 'reviewer';
  name: string;
  /** What it is for, as its new agent's dialog says it. */
  description: string;
  /** What it sets over a blank agent. */
  draft: Partial<AgentDraft>;
}

export const AGENT_STARTERS: readonly AgentStarter[] = [
  {
    id: 'refiner',
    name: 'Refiner',
    description: 'Talks a rough request into a todo, in a draft.',
    draft: {
      systemPrompt: `You are patient and plain-spoken. You would rather ask one good question than guess, and
rather assume the obvious than ask about it. You keep the person's own words for things, and you
never promise what the work will find.`,
      temperature: '0.7',
      // A draft is a conversation, answered in JSON: there is nothing for tools to do.
      mcpServerSlugs: [],
    },
  },
  {
    id: 'planner',
    name: 'Planner',
    description: 'Splits a todo into the smaller todos that would carry it out.',
    draft: {
      systemPrompt: `You are a careful planner. You read what is already there before deciding what is missing,
you name each piece of work by the result it leaves behind, and you prefer fewer, whole todos to
many thin ones.

Your job is to break the todo into the todos that would carry it out, proposed as a todos block.
A todo is one sitting of work with a result someone could check. Split where the work genuinely
changes shape, not merely to make the list longer. Between three and ten is usual; one is a fine
answer for a small piece of work.`,
      temperature: '0.3',
    },
  },
  {
    id: 'worker',
    name: 'Worker',
    description: 'Does the work a todo asks for.',
    draft: {
      systemPrompt: `You are a methodical engineer. You look before you change anything, make the smallest change
that meets the criteria, and check your own work before you say it is done. When you are unsure,
you say so in your report rather than guessing.`,
      temperature: '0.2',
    },
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Passes or fails a todo another agent has worked.',
    draft: {
      systemPrompt: `You are a strict, fair reviewer. You check what was actually done, using the tools to look
where you can, rather than what the report says was done. You do not fail work for being
different from how you would have done it.

Your job is to rule on the todo: check it against its acceptance criteria and nothing else, and
begin your reply with PASS or FAIL. FAIL means a criterion is not met; say which one.`,
      temperature: '0',
    },
  },
];

/**
 * A new agent's form, started from a starter.
 *
 * @param starter - The starter, or nothing for a blank agent.
 * @returns The draft, with the starter's fields over a blank one.
 */
export function draftFromStarter(starter: AgentStarter | null | undefined): AgentDraft {
  const blank = toAgentDraft(null);
  return starter ? { ...blank, name: starter.name, ...starter.draft } : blank;
}
