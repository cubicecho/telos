import { describe, expect, it } from 'vitest';
import { AGENT_STARTERS, draftFromStarter } from '../agent-starters';
import { fromAgentDraft, toAgentDraft } from '../agents';

describe('agent starters', () => {
  it('are the four kanban_server came with', () => {
    expect(AGENT_STARTERS.map((starter) => starter.name)).toEqual(['Refiner', 'Planner', 'Worker', 'Reviewer']);
  });

  it('leave the endpoint and the model blank, to be given or inherited', () => {
    for (const starter of AGENT_STARTERS) {
      const values = fromAgentDraft(draftFromStarter(starter));
      expect(values.name).toBe(starter.name);
      expect(values.baseUrl).toBeNull();
      expect(values.model).toBeNull();
      expect(values.systemPrompt).toBeTruthy();
      expect(values.temperature).toEqual(expect.any(Number));
    }
  });

  it('give a person who picks none a blank agent', () => {
    expect(draftFromStarter(null)).toEqual(toAgentDraft(null));
  });
});
