import { describe, expect, it } from 'vitest';
import { ArtifactLog, declaredArtifact, detectArtifact, mediaTypeFor, noteArtifact } from '../artifacts.ts';

describe('reading a write out of a tool call', () => {
  it('knows a write by its verb and its path', () => {
    expect(detectArtifact('fs__write_file', { path: '/a/b.md', content: 'hi' })).toMatchObject({
      location: '/a/b.md',
      source: 'detected',
      action: 'created',
      serverSlug: 'fs',
      tool: 'write_file',
      mediaType: 'text/markdown',
      sizeBytes: 2,
    });
    expect(detectArtifact('fs__edit_file', { path: 'x.ts' })?.action).toBe('updated');
    expect(detectArtifact('fs__move_file', { source: 'a', destination: 'b' })).toMatchObject({
      location: 'b',
      action: 'moved',
    });
    expect(detectArtifact('fs__delete_file', { path: 'gone.txt' })?.action).toBe('deleted');
  });

  it('ignores reads, directories, pathless writes and the board’s own tools', () => {
    expect(detectArtifact('fs__read_file', { path: 'a' })).toBeNull();
    expect(detectArtifact('fs__create_directory', { path: 'a' })).toBeNull();
    expect(detectArtifact('fs__write_file', { content: 'a' })).toBeNull();
    expect(detectArtifact('telos__create_request', { url: 'x' })).toBeNull();
  });

  it('believes a declaration, and needs its location', () => {
    expect(declaredArtifact({ location: ' s3://b/k.png ', title: 'Chart' })).toMatchObject({
      location: 's3://b/k.png',
      source: 'declared',
      title: 'Chart',
      mediaType: 'image/png',
    });
    expect(declaredArtifact({ title: 'Nowhere' })).toBeNull();
  });

  it('keeps one per location, the declaration’s words and the last action', () => {
    const log = new ArtifactLog();
    log.add(detectArtifact('fs__write_file', { path: 'p.md', content: 'one' }));
    log.add(declaredArtifact({ location: 'p.md', title: 'Plan' }));
    log.add(detectArtifact('fs__edit_file', { path: 'p.md', content: 'three' }));
    expect(log.list()).toEqual([
      expect.objectContaining({
        location: 'p.md',
        source: 'declared',
        action: 'updated',
        title: 'Plan',
        tool: 'edit_file',
        sizeBytes: 5,
      }),
    ]);
  });

  it('guesses a media type off the extension only', () => {
    expect(mediaTypeFor('https://x/y/report.PDF?v=1')).toBe('application/pdf');
    expect(mediaTypeFor('/a/.env')).toBeNull();
    expect(mediaTypeFor('/a/Makefile')).toBeNull();
  });
});

describe('what a declaration has to point at', () => {
  it('is believed only when a tool call in the run carried the location', () => {
    const log = new ArtifactLog();
    expect(log.seen('/work/plan.md')).toBe(false);
    log.witness({ path: 'work/plan.md', content: '# Plan' }, 'Wrote 6 bytes.');
    expect(log.seen('/work/plan.md')).toBe(true);
    expect(log.seen('file:///work/plan.md')).toBe(true);
    expect(log.seen('fs:///quinton_lucas_summary.md')).toBe(false);
    log.witness({ bucket: 'b' }, '{"url":"https://cdn.example.com/x/report.pdf"}');
    expect(log.seen('https://cdn.example.com/x/report.pdf')).toBe(true);
    expect(log.seen('  ')).toBe(false);
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
});
