import { type AgentDraft, toAgentDraft } from './agents';

// Three of the agents kanban_server came with (planner, worker, reviewer), as
// starting text for a new agent. An agent's instructions are all
// it is told about its job: how its reply is read (PASS or FAIL, a report, a
// `todos` block) is the runner's standing protocol and is sent whatever the
// agent says (runner/src/prompts.ts). What a starter
// leaves out is left blank, inheriting the agent defaults: above all the
// endpoint and the model, which are the only things someone has to add.

export interface AgentStarter {
  /** Its key. */
  id: 'planner' | 'worker' | 'reviewer';
  name: string;
  /** What it is for, as its new agent's dialog says it. */
  description: string;
  /** What it sets over a blank agent. */
  draft: Partial<AgentDraft>;
}

export const AGENT_STARTERS: readonly AgentStarter[] = [
  {
    id: 'planner',
    name: 'Planner',
    description: 'Makes a todo ready for a worker: rewrites it, or splits it into smaller todos.',
    draft: {
      systemPrompt: `You are a careful planner. You read what is already there before deciding what is missing,
you name each piece of work by the result it leaves behind, and you prefer fewer, whole todos to
many thin ones.

Your job is to make the todo ready for someone to do in one sitting, never to do it yourself. A
todo is one sitting of work with a result someone could check. When the todo is one piece of work,
refine it: a clear title, a brief that says what to change and where, and acceptance someone could
check. When it is genuinely several, split it into a todos block, where the work changes shape and
not merely to make the list longer; between two and ten is usual.`,
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
