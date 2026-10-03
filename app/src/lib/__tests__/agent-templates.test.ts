import { describe, expect, it } from 'vitest';
import { AGENT_TEMPLATES, draftFromTemplate } from '../agent-templates';
import { fromAgentDraft, toAgentDraft } from '../agents';

describe('agent templates', () => {
  it('are the four kanban_server came with, one per job', () => {
    expect(AGENT_TEMPLATES.map((template) => template.name)).toEqual(['Refiner', 'Planner', 'Worker', 'Reviewer']);
  });

  it('leave the endpoint and the model blank, to be given or inherited', () => {
    for (const template of AGENT_TEMPLATES) {
      const values = fromAgentDraft(draftFromTemplate(template));
      expect(values.name).toBe(template.name);
      expect(values.baseUrl).toBeNull();
      expect(values.model).toBeNull();
      expect(values.systemPrompt).toBeTruthy();
      expect(values.temperature).toEqual(expect.any(Number));
    }
  });

  it('give a person who picks none a blank agent', () => {
    expect(draftFromTemplate(null)).toEqual(toAgentDraft(null));
  });
});
