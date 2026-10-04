import { describe, expect, it } from 'vitest';
import { briefPrompt, systemPromptFor } from '../prompts.ts';
import type { Brief } from '../telos.ts';

const BRIEF: Brief = {
  projectName: 'Telos',
  projectDescription: 'A board.',
  projectContext: 'TypeScript, npm.',
  laneName: 'Doing',
  contract: 'work',
  lanePrompt: null,
  title: 'Add a search box',
  brief: 'On the todos page.',
  acceptance: 'Typing filters the list.',
  report: 'Added the box.',
  why: 'It does not filter.',
  notes: ['It does not filter.', 'Keep it small.'],
};

describe('systemPromptFor', () => {
  it('says where the agent is first, then who it is', () => {
    const system = systemPromptFor(BRIEF, 'You are careful.');
    const where = system.indexOf('Project: Telos');
    const who = system.indexOf('You are careful.');

    expect(where).toBe(0);
    expect(system).toContain('A board.');
    expect(system).toContain('TypeScript, npm.');
    expect(who).toBeGreaterThan(where);
  });

  it('leaves out what the agent has not got', () => {
    const system = systemPromptFor({ ...BRIEF, projectDescription: null, projectContext: null }, null);

    expect(system.startsWith('Project: Telos\n\n')).toBe(true);
    expect(system).not.toContain('null');
  });
});

describe('briefPrompt', () => {
  it('gives the todo, its criteria, the last report, why it came back, then the other notes', () => {
    const prompt = briefPrompt(BRIEF);
    const order = [
      'Todo: Add a search box',
      'On the todos page.',
      'Done when:',
      'What the last agent reported:',
      'Why this came back:',
      '- Keep it small.',
    ].map((part) => prompt.indexOf(part));

    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(prompt.match(/It does not filter\./g)).toHaveLength(1);
  });
});
