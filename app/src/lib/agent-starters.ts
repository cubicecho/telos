import { type AgentDraft, toAgentDraft } from './agents';

// Three of the agents kanban_server came with (planner, worker, reviewer), as
// starting points for a new agent. What an agent is told about its job is its
// prompt, and every account starts with one of each kind, named as these are
// (db/src/prompt-seeds.ts): a starter picks the prompt of its own name, when
// the account still has one. What a starter leaves out is left blank,
// inheriting the agent defaults: above all the endpoint and the model, which
// are the only things someone has to add.

export interface AgentStarter {
  /** Its key. */
  id: 'planner' | 'worker' | 'reviewer';
  name: string;
  /** What it is for, as its new agent's dialog says it. */
  description: string;
  /** The name of the account's prompt it starts with. */
  prompt: 'Planner' | 'Worker' | 'Reviewer';
  /** What it sets over a blank agent, besides its prompt. */
  draft: Partial<AgentDraft>;
}

export const AGENT_STARTERS: readonly AgentStarter[] = [
  {
    id: 'planner',
    name: 'Planner',
    description: 'Makes a todo ready for a worker: rewrites it, or splits it into smaller todos.',
    prompt: 'Planner',
    draft: { temperature: '0.3' },
  },
  {
    id: 'worker',
    name: 'Worker',
    description: 'Does the work a todo asks for.',
    prompt: 'Worker',
    draft: { temperature: '0.2' },
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Passes or fails a todo another agent has worked.',
    prompt: 'Reviewer',
    draft: { temperature: '0' },
  },
];

/**
 * A new agent's form, started from a starter.
 *
 * @param starter - The starter, or nothing for a blank agent.
 * @param prompts - The account's prompts, to find the starter's by name.
 * @returns The draft, with the starter's fields over a blank one, and its
 *   prompt when the account has one of that name.
 */
export function draftFromStarter(
  starter: AgentStarter | null | undefined,
  prompts: readonly { id: string; name: string }[] = [],
): AgentDraft {
  const blank = toAgentDraft(null);
  if (!starter) return blank;
  const prompt = prompts.find((candidate) => candidate.name === starter.prompt);
  return { ...blank, name: starter.name, ...starter.draft, promptId: prompt?.id ?? null };
}
