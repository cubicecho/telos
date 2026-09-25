import { describe, expect, it } from 'vitest';
import { ArtifactLog, declaredArtifact, detectArtifact, mediaTypeFor } from '../artifacts.ts';

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
