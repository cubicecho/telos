import { describe, expect, it } from 'vitest';
import { assignmentPrompt, readReply, STANDING_SYSTEM, systemPromptFor } from '../prompts.ts';
import type { Assignment } from '../telos.ts';

const ASSIGNMENT: Assignment = {
  projectName: 'Telos',
  projectDescription: 'A board.',
  projectContext: 'TypeScript, npm.',
  laneName: 'Doing',
  title: 'Add a search box',
  brief: 'On the todos page.',
  acceptance: 'Typing filters the list.',
  report: 'Added the box.',
  why: 'It does not filter.',
  notes: ['It does not filter.', 'Keep it small.'],
};

describe('systemPromptFor', () => {
  it('says where the agent is first, then who it is', () => {
    const system = systemPromptFor(ASSIGNMENT, 'You are careful.');
    const where = system.indexOf('Project: Telos');
    const who = system.indexOf('You are careful.');

    expect(where).toBe(0);
    expect(system).toContain('A board.');
    expect(system).toContain('TypeScript, npm.');
    expect(who).toBeGreaterThan(where);
    expect(system.endsWith(STANDING_SYSTEM)).toBe(true);
  });

  it('leaves out what the agent has not got', () => {
    const system = systemPromptFor({ ...ASSIGNMENT, projectDescription: null, projectContext: null }, null);

    expect(system.startsWith('Project: Telos\n\n')).toBe(true);
    expect(system).not.toContain('null');
  });
});

describe('assignmentPrompt', () => {
  it('gives the todo, its criteria, the last report, why it came back, then the other notes', () => {
    const prompt = assignmentPrompt(ASSIGNMENT);
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

describe('readReply', () => {
  it('takes a todos block out of the report and reads its todos', () => {
    const reply = 'PASS\nLooks right.\n\n```todos\n[{"title":"Add tests","dependsOn":[]},{"brief":"no title"}]\n```';

    expect(readReply(reply)).toEqual({
      report: 'PASS\nLooks right.',
      todos: [{ title: 'Add tests', brief: null, acceptance: null, dependsOn: [] }],
    });
  });

  it('leaves a reply with no todos block as it is', () => {
    expect(readReply('Done: added the box.')).toEqual({ report: 'Done: added the box.', todos: [] });
  });

  it('reads no todos from a block that is not JSON', () => {
    expect(readReply('Done.\n```todos\nnot json\n```').todos).toEqual([]);
  });
});
