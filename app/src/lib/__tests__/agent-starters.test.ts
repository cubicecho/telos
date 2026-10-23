import { describe, expect, it } from 'vitest';
import { AGENT_STARTERS, draftFromStarter } from '../agent-starters';
import { fromAgentDraft, toAgentDraft } from '../agents';

/** The prompts every account starts with (db/src/prompt-seeds.ts), by name. */
const PROMPTS = ['Planner', 'Reviewer', 'Worker'].map((name) => ({ id: `p-${name.toLowerCase()}`, name }));

describe('agent starters', () => {
  it('are the planner, worker and reviewer kanban_server came with', () => {
    expect(AGENT_STARTERS.map((starter) => starter.name)).toEqual(['Planner', 'Worker', 'Reviewer']);
  });

  it('leave the endpoint and the model blank, to be given or inherited', () => {
    for (const starter of AGENT_STARTERS) {
      const values = fromAgentDraft(draftFromStarter(starter, PROMPTS));
      expect(values.name).toBe(starter.name);
      expect(values.baseUrl).toBeNull();
      expect(values.model).toBeNull();
      expect(values.temperature).toEqual(expect.any(Number));
    }
  });

  it('pick the account’s prompt of their own name', () => {
    expect(AGENT_STARTERS.map((starter) => draftFromStarter(starter, PROMPTS).promptId)).toEqual([
      'p-planner',
      'p-worker',
      'p-reviewer',
    ]);
  });

  it('start with no prompt when the account has none of that name', () => {
    const [planner] = AGENT_STARTERS;
    expect(draftFromStarter(planner, [{ id: 'p-other', name: 'Other' }]).promptId).toBeNull();
    expect(draftFromStarter(planner).promptId).toBeNull();
  });

  it('give a person who picks none a blank agent', () => {
    expect(draftFromStarter(null)).toEqual(toAgentDraft(null));
  });
});
