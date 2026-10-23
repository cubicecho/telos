import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_INSTRUCTIONS, SEEDED_PROMPTS } from '../../../db/src/prompt-seeds.ts';
import { assignmentPrompt, REVIEW_NOTE, readReply, systemPromptFor } from '../prompts.ts';
import type { Assignment } from '../telos.ts';

const ASSIGNMENT: Assignment = {
  agentInstructions: 'Say what you tried.',
  projectName: 'Telos',
  projectDescription: 'A board.',
  projectPrompt: null,
  laneName: 'Doing',
  title: 'Add a search box',
  brief: 'On the todos page.',
  acceptance: 'Typing filters the list.',
  report: 'Added the box.',
  why: 'It does not filter.',
  notes: ['It does not filter.', 'Keep it small.'],
  reviews: false,
  ruling: null,
  artifacts: [],
};

describe('systemPromptFor', () => {
  it("puts the agent instructions, the project, its prompt and the agent's prompt in that order", () => {
    const system = systemPromptFor(
      { ...ASSIGNMENT, projectPrompt: 'Keep artifacts in /srv/telos.\n' },
      'You are careful.',
    );

    expect(system).toBe(
      'Say what you tried.\n\nProject: Telos\n\nA board.\n\nKeep artifacts in /srv/telos.\n\nYou are careful.',
    );
  });

  it('leaves out a blank layer, and adds no text of its own', () => {
    const system = systemPromptFor(
      { ...ASSIGNMENT, agentInstructions: ' \n', projectDescription: null, projectPrompt: '  ' },
      null,
    );

    expect(system).toBe('Project: Telos');
  });

  it('sends the instructions the server resolved, word for word, first', () => {
    const system = systemPromptFor({ ...ASSIGNMENT, agentInstructions: DEFAULT_AGENT_INSTRUCTIONS }, null);

    expect(system.startsWith(DEFAULT_AGENT_INSTRUCTIONS)).toBe(true);
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain('ask_person');
  });
});

describe('the seeded prompts', () => {
  const body = (name: string) => SEEDED_PROMPTS.find((prompt) => prompt.name === name)?.body ?? '';

  it('are a Planner, a Reviewer and a Worker', () => {
    expect(SEEDED_PROMPTS.map((prompt) => prompt.name)).toEqual(['Planner', 'Reviewer', 'Worker']);
  });

  it('ask the Worker to plan, check each criterion, and end on its three sections', () => {
    const worker = body('Worker');
    expect(worker).toContain('First plan it');
    expect(worker).toContain('check every criterion yourself');
    const sections = ['## Changes', '## Verification', '## Open questions'].map((section) => worker.indexOf(section));
    expect(sections.every((at) => at >= 0)).toBe(true);
    expect([...sections].sort((a, b) => a - b)).toEqual(sections);
  });

  it('ask the Reviewer for PASS or FAIL first, then each criterion with quoted evidence', () => {
    const reviewer = body('Reviewer');
    expect(reviewer).toContain('Begin your reply with PASS or FAIL on its own line');
    expect(reviewer).toContain('one at a time');
    expect(reviewer).toContain('quote the evidence');
    expect(reviewer).toContain('FAIL only on a criterion you can name as not met');
  });

  it('tell the Worker and the Planner not to open on PASS or FAIL, which reads as a ruling', () => {
    for (const name of ['Worker', 'Planner']) {
      expect(body(name)).toContain('Do not begin your reply with the word PASS or FAIL');
    }
  });

  it('read a Planner refine in the shape its prompt shows', () => {
    const shown = /```refine\n[\s\S]*?```/.exec(body('Planner'))?.[0] ?? '';
    const reply = readReply(`The todo is one piece of work.\n\n${shown}`);

    expect(reply.report).toBe('The todo is one piece of work.');
    expect(reply.refine).toEqual({
      title: 'imperative, under about ten words',
      brief: 'what to do, where, and what to watch out for',
      acceptance: '- one line per thing someone can check to tell this todo is done',
    });
    expect(reply.todos).toEqual([]);
  });

  it('read a Planner split in the shape its prompt shows', () => {
    const shown = /```todos\n[\s\S]*?```/.exec(body('Planner'))?.[0] ?? '';
    const reply = readReply(`Two pieces.\n\n${shown}`);

    expect(reply.report).toBe('Two pieces.');
    expect(reply.todos).toHaveLength(1);
    expect(reply.todos[0]?.title).toBe('imperative, under about ten words');
    expect(reply.todos[0]?.dependsOn).toEqual(['exact titles of todos in this list that must finish first']);
    expect(reply.refine).toBeNull();
  });

  it('keep a Worker report as it is', () => {
    const report =
      'Plan:\n- add the box\n\n## Changes\nAdded it.\n\n## Verification\nTyped; it filtered.\n\n## Open questions\nNone.';

    expect(readReply(report)).toEqual({ report, todos: [], refine: null });
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
    expect(prompt).not.toContain(REVIEW_NOTE);
  });

  it('tells a reviewer it rules on the work, and where the work is', () => {
    const prompt = assignmentPrompt({
      ...ASSIGNMENT,
      reviews: true,
      report: null,
      why: null,
      ruling: 'FAIL\n- Typing filters the list: not met.',
      artifacts: [
        { location: 'src/search.tsx', action: 'updated', title: 'The search box' },
        { location: 'https://example.com/pr/1', action: 'created', title: null },
      ],
    });

    expect(prompt).toContain(REVIEW_NOTE);
    expect(prompt).not.toContain('What the last agent reported');
    expect(prompt).toContain('- updated src/search.tsx (The search box)\n- created https://example.com/pr/1');
    expect(prompt).toContain('The last ruling on this todo:\nFAIL\n- Typing filters the list: not met.');
    const order = ['Done when:', REVIEW_NOTE, 'What has been made', 'The last ruling'].map((part) =>
      prompt.indexOf(part),
    );
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('gives the last ruling once, when it is already why the todo came back', () => {
    const ruling = 'FAIL\n- Typing filters the list: not met.';
    const prompt = assignmentPrompt({ ...ASSIGNMENT, ruling, why: ruling });

    expect(prompt).not.toContain('The last ruling on this todo');
    expect(prompt.match(/not met\./g)).toHaveLength(1);
  });
});

describe('readReply', () => {
  it('takes a todos block out of the report and reads its todos', () => {
    const reply = 'PASS\nLooks right.\n\n```todos\n[{"title":"Add tests","dependsOn":[]},{"brief":"no title"}]\n```';

    expect(readReply(reply)).toEqual({
      report: 'PASS\nLooks right.',
      todos: [{ title: 'Add tests', brief: null, acceptance: null, dependsOn: [] }],
      refine: null,
    });
  });

  it('leaves a reply with no todos block as it is', () => {
    expect(readReply('Done: added the box.')).toEqual({ report: 'Done: added the box.', todos: [], refine: null });
  });

  it('leaves a structured report whole: its sections are the report', () => {
    const reply =
      'Planned: the box, then the filter.\n\n## Changes\nAdded src/search.tsx.\n\n' +
      '## Verification\n- Typing filters the list: `npm test` printed "12 passed".\n\n## Open questions\nNone.';

    expect(readReply(reply)).toEqual({ report: reply, todos: [], refine: null });
  });

  it('leaves a ruling per criterion whole, its first word first', () => {
    const reply =
      'FAIL\n- Typing filters the list: met. `npm test` printed "12 passed".\n' +
      '- The box is labelled: not met. src/search.tsx:4 reads `<input />`.';
    const read = readReply(reply);

    expect(read).toEqual({ report: reply, todos: [], refine: null });
    expect(read.report.split(/\s/)[0]).toBe('FAIL');
  });

  it('reads no todos from a block that is not JSON', () => {
    expect(readReply('Done.\n```todos\nnot json\n```').todos).toEqual([]);
  });

  it('takes a refine block out of the report and reads the todo it rewrote', () => {
    const reply =
      'Narrowed it down.\n\n```refine\n{"title":"Stream the export","body":"Rows, not one string.","extra":1}\n```';

    expect(readReply(reply)).toEqual({
      report: 'Narrowed it down.',
      todos: [],
      refine: { title: 'Stream the export', brief: 'Rows, not one string.', acceptance: null },
    });
  });

  it('reads both blocks when a reply holds both, for the server to refuse', () => {
    const read = readReply('```refine\n{"title":"A"}\n```\n```todos\n[{"title":"B"},{"title":"C"}]\n```');

    expect(read.report).toBe('');
    expect(read.refine?.title).toBe('A');
    expect(read.todos.map((todo) => todo.title)).toEqual(['B', 'C']);
  });

  it('reads no refine from a block that holds no object', () => {
    expect(readReply('Done.\n```refine\n["a list"]\n```').refine).toBeNull();
  });
});
