import type { RunArtifact } from '@cubicecho/agent-core';
import { describe, expect, it } from 'vitest';
import { ArtifactLog, detects, draftOf, noteArtifact } from '../artifacts.ts';

const call = (name: string) => ({ id: 'c1', name, args: {}, raw: '{}', repaired: false });

describe('what the loop reads for a write', () => {
  it('is every tool but the board’s own', () => {
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

  it('is stored as telos keeps one, split at its server', () => {
    expect(draftOf(written)).toEqual({
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
    expect(draftOf(linked)).toMatchObject({ source: 'detected', action: 'created', serverSlug: null, tool: 'up' });
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
    expect(noteArtifact('telos__add_todo_note', { todoId: 'other', body: 'x' }, answer, 't1')).toBeNull();
    expect(noteArtifact('telos__submit_request', { todoId: 't1', body: 'x' }, answer, 't1')).toBeNull();
    expect(noteArtifact('desk__add_todo_note', { todoId: 't1', body: 'x' }, answer, 't1')).toBeNull();
    expect(noteArtifact('telos__add_todo_note', { todoId: 't1', body: 'x' }, 'Error: nope', 't1')).toBeNull();
  });

  it('is listed beside what the loop collected', () => {
    const log = new ArtifactLog();
    log.note(noteArtifact('telos__add_todo_note', { todoId: 't1', body: 'x' }, JSON.stringify({ id }), 't1'));
    log.note(null);
    log.fromLoop([{ link: { uri: 'a.md', name: 'a.md' }, callId: 'c1', tool: 'fs__write_file', step: 0, count: 1 }]);
    expect(log.list().map((draft) => draft.location)).toEqual(['a.md', `telos:note/${id}`]);
  });
});
