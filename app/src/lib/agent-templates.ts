import { type AgentDraft, toAgentDraft } from './agents';

// The four agents kanban_server came with (refiner, decomposer, executor,
// reviewer), as starting points for a new one. The job itself — what a work,
// verdict or expand station asks, and how a draft is answered — is the runner's and
// is sent whatever the agent says (runner/src/prompts.ts, runner/src/drafts.ts),
// so a template's prompt says only who the agent is, never its job again. What
// a template leaves out is left blank, inheriting the agent defaults: above
// all the endpoint and the model, which are the only things someone has to add.

export interface AgentTemplate {
  /** Its key. */
  id: 'refiner' | 'planner' | 'worker' | 'reviewer';
  name: string;
  /** What it is for, as its new agent's dialog says it. */
  description: string;
  /** Where it goes, a contract or drafts, beside its name in the menu. */
  use: string;
  /** What it sets over a blank agent. */
  draft: Partial<AgentDraft>;
}

export const AGENT_TEMPLATES: readonly AgentTemplate[] = [
  {
    id: 'refiner',
    name: 'Refiner',
    description: 'Talks a rough request into a todo, in a draft.',
    use: 'Drafts',
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
    description: 'Splits a todo into smaller ones, at a station with the Expand contract.',
    use: 'Expand',
    draft: {
      systemPrompt: `You are a careful planner. You read what is already there before deciding what is missing,
you name each piece of work by the result it leaves behind, and you prefer fewer, whole todos to
many thin ones.`,
      temperature: '0.3',
    },
  },
  {
    id: 'worker',
    name: 'Worker',
    description: 'Does the work a todo asks for, at a station with the Work contract.',
    use: 'Work',
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
    description: 'Passes or fails worked todos, at a station with the Verdict contract.',
    use: 'Verdict',
    draft: {
      systemPrompt: `You are a strict, fair reviewer. You check what was actually done, using the tools to look
where you can, rather than what the report says was done. You do not fail work for being
different from how you would have done it.`,
      temperature: '0',
    },
  },
];

/**
 * A new agent's form, started from a template.
 *
 * @param template - The template, or nothing for a blank agent.
 * @returns The draft, with the template's fields over a blank one.
 */
export function draftFromTemplate(template: AgentTemplate | null | undefined): AgentDraft {
  const blank = toAgentDraft(null);
  return template ? { ...blank, name: template.name, ...template.draft } : blank;
}
