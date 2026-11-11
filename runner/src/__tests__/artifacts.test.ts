import type { RunArtifact } from '@cubicecho/agent-core';
import { describe, expect, it } from 'vitest';
import { ArtifactLog, type DescribeTool, detectsFor, draftOf, noteArtifact } from '../artifacts.ts';

const call = (name: string) => ({ id: 'c1', name, args: {}, raw: '{}', repaired: false });

// The pool, as far as these need it: who offers each tool. A long name is one
// the pool shortened and put a hash on, so only the pool can say whose it is.
const TOOLS: Record<string, { serverId: string; name: string }> = {
  fs__write_file: { serverId: 'fs', name: 'write_file' },
  fs__edit_file: { serverId: 'fs', name: 'edit_file' },
  my__docs__save_3f9a: { serverId: 'my__docs', name: 'save_a_page_with_a_very_long_name' },
  telos__create_request: { serverId: 'telos', name: 'create_request' },
  telos__add_todo_note: { serverId: 'telos', name: 'add_todo_note' },
  telos__submit_request: { serverId: 'telos', name: 'submit_request' },
  desk__add_todo_note: { serverId: 'desk', name: 'add_todo_note' },
};
const describeTool: DescribeTool = (name) => TOOLS[name];

describe('what the loop reads for a write', () => {
  it('is every tool but the board’s own', () => {
    const detects = detectsFor(describeTool);
    expect(detects(call('fs__write_file'))).toBe(true);
    expect(detects(call('write_file'))).toBe(true);
    expect(detects(call('telos__create_request'))).toBe(false);
  });
});

describe('an artifact the loop collected', () => {
  const written: RunArtifact = {
    link: { uri: '/work/plan.md', name: 'plan.md', title: 'The plan', mimeType: 'text/markdown' },
    callId: 'c1',
    tool: 'fs__edit_file',
    step: 0,
    count: 2,
    source: 'declared',
    action: 'updated',
    sizeBytes: 6,
  };

  it('is stored as telos keeps one, under the server the pool says offers it', () => {
    expect(draftOf(written, describeTool)).toEqual({
      location: '/work/plan.md',
      source: 'declared',
      action: 'updated',
      serverSlug: 'fs',
      tool: 'edit_file',
      title: 'The plan',
      description: null,
      mediaType: 'text/markdown',
      sizeBytes: 6,
    });
  });

  it('is created where no write said otherwise, and a link is kept as a guess', () => {
    const linked: RunArtifact = {
      link: { uri: 's3://b/k.png', name: 'k.png' },
      callId: 'c2',
      tool: 'up',
      step: 1,
      count: 1,
    };
    expect(draftOf(linked, describeTool)).toMatchObject({
      source: 'detected',
      action: 'created',
      serverSlug: null,
      tool: 'up',
    });
  });

  it('names a tool whose name the pool shortened by what the pool says, not by its first `__`', () => {
    expect(draftOf({ ...written, tool: 'my__docs__save_3f9a' }, describeTool)).toMatchObject({
      serverSlug: 'my__docs',
      tool: 'save_a_page_with_a_very_long_name',
    });
  });
});

describe('a note the agent left on its todo', () => {
  const id = '0b8f6a1e-5a6c-4d2b-9a57-3c1f2e4d5b6a';

  it('is kept as a link to the note, titled by its first line', () => {
    expect(
      noteArtifact(
        'telos__add_todo_note',
        { todoId: 't1', body: '## Findings\nThe rest.' },
        JSON.stringify({ addTodoNote: { id, createdAt: 'now' } }),
        't1',
        describeTool,
      ),
    ).toEqual({
      location: `telos:note/${id}`,
      source: 'detected',
      action: 'created',
      serverSlug: 'telos',
      tool: 'add_todo_note',
      title: 'Findings',
      mediaType: 'text/markdown',
      sizeBytes: 21,
    });
  });

  it('is not kept for another todo, another tool, or an answer without an id', () => {
    const answer = JSON.stringify({ id });
    expect(noteArtifact('telos__add_todo_note', { todoId: 'other', body: 'x' }, answer, 't1', describeTool)).toBeNull();
    expect(noteArtifact('telos__submit_request', { todoId: 't1', body: 'x' }, answer, 't1', describeTool)).toBeNull();
    expect(noteArtifact('desk__add_todo_note', { todoId: 't1', body: 'x' }, answer, 't1', describeTool)).toBeNull();
    expect(
      noteArtifact('telos__add_todo_note', { todoId: 't1', body: 'x' }, 'Error: nope', 't1', describeTool),
    ).toBeNull();
  });

  it('is listed beside what the loop collected', () => {
    const log = new ArtifactLog();
    log.note(
      noteArtifact('telos__add_todo_note', { todoId: 't1', body: 'x' }, JSON.stringify({ id }), 't1', describeTool),
    );
    log.note(null);
    log.fromLoop(
      [{ link: { uri: 'a.md', name: 'a.md' }, callId: 'c1', tool: 'fs__write_file', step: 0, count: 1 }],
      describeTool,
    );
    expect(log.list().map((draft) => draft.location)).toEqual(['a.md', `telos:note/${id}`]);
  });
});
