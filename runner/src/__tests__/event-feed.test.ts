import { describe, expect, it } from 'vitest';
import { EventFeed } from '../execute.ts';

// What a run tells telos between heartbeats: streamed tokens as blocks, the
// prompt until it lands, and the latest of what it has spent.

describe('EventFeed', () => {
  it('joins streamed tokens into one block per kind, in order', () => {
    const feed = new EventFeed();
    for (const text of ['Let ', 'me ', 'think.']) feed.fromLoop({ kind: 'thinking', text });
    feed.fromLoop({ kind: 'tool-call', name: 'fs__read', text: '{}' });
    for (const text of ['Do', 'ne.']) feed.fromLoop({ kind: 'output', text });
    expect(feed.drain().events).toEqual([
      { kind: 'thinking', text: 'Let me think.' },
      { kind: 'tool_call', name: 'fs__read', ok: null, text: '{}' },
      { kind: 'output', text: 'Done.' },
    ]);
  });

  it('is idle only with nothing to say, and says the prompt until a beat lands', () => {
    const feed = new EventFeed();
    expect(feed.idle).toBe(true);
    feed.prompt({ system: 'S', user: 'U' });
    expect(feed.idle).toBe(false);
    const failed = feed.drain();
    expect(failed.prompt).toEqual({ system: 'S', user: 'U' });
    feed.restore(failed);
    expect(feed.drain().prompt).toEqual({ system: 'S', user: 'U' });
    expect(feed.idle).toBe(true);
    expect(feed.drain().prompt).toBeUndefined();
  });

  it('sends the latest usage once, with the tool calls so far', () => {
    const feed = new EventFeed();
    feed.fromLoop({ kind: 'tool-call', name: 'a' });
    feed.fromLoop({ kind: 'usage', usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } });
    feed.fromLoop({ kind: 'usage', usage: { promptTokens: 30, completionTokens: 5, totalTokens: 35 } });
    expect(feed.drain().usage).toEqual({ toolCalls: 1, promptTokens: 30, completionTokens: 5, totalTokens: 35 });
    expect(feed.drain().usage).toBeUndefined();
  });
});
