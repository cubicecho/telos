import { describe, expect, it } from 'vitest';
import { type CachedTodo, resolveBlocking } from '../blocking';

/** A todo as the project list holds it, with only the interesting bits stated. */
function todo(id: string, fields: Partial<CachedTodo> = {}): CachedTodo {
  return {
    __typename: 'Todo',
    id,
    title: id,
    notes: null,
    dueAt: null,
    completedAt: null,
    position: 0,
    isBlocked: false,
    blockedBy: [],
    dependencies: [],
    labels: [],
    lane: null,
    ...fields,
  };
}

/** `dependencies` as the cache holds them: a snapshot of the blocker's row. */
function dependency(on: CachedTodo) {
  return { __typename: 'Todo' as const, id: on.id, title: on.title, completedAt: on.completedAt };
}

describe('resolveBlocking', () => {
  it('blocks a todo whose dependency is still open', () => {
    const blocker = todo('blocker');
    const waiter = todo('waiter', { dependencies: [dependency(blocker)] });

    const [, resolved] = resolveBlocking([blocker, waiter]);

    expect(resolved.isBlocked).toBe(true);
    expect(resolved.blockedBy).toEqual([{ __typename: 'Todo', id: 'blocker', title: 'blocker' }]);
  });

  it('unblocks a todo when its blocker is completed in the same list', () => {
    // The stale copy inside `dependencies` is what a naive patch would leave
    // behind: the blocker's own row says done, its dependent's snapshot of it
    // still says open.
    const blocker = todo('blocker', { completedAt: '2026-09-09T00:00:00.000Z' });
    const waiter = todo('waiter', {
      isBlocked: true,
      blockedBy: [{ __typename: 'Todo', id: 'blocker', title: 'blocker' }],
      dependencies: [{ __typename: 'Todo', id: 'blocker', title: 'blocker', completedAt: null }],
    });

    const [, resolved] = resolveBlocking([blocker, waiter]);

    expect(resolved.isBlocked).toBe(false);
    expect(resolved.blockedBy).toEqual([]);
    expect(resolved.dependencies[0]?.completedAt).toBe('2026-09-09T00:00:00.000Z');
  });

  it('drops a dependency on a todo that is no longer in the list', () => {
    const waiter = todo('waiter', {
      isBlocked: true,
      blockedBy: [{ __typename: 'Todo', id: 'deleted', title: 'deleted' }],
      dependencies: [{ __typename: 'Todo', id: 'deleted', title: 'deleted', completedAt: null }],
    });

    const [resolved] = resolveBlocking([waiter]);

    expect(resolved.dependencies).toEqual([]);
    expect(resolved.isBlocked).toBe(false);
  });

  it('keeps a todo blocked while any one of several dependencies is open', () => {
    const done = todo('done', { completedAt: '2026-09-09T00:00:00.000Z' });
    const open = todo('open');
    const waiter = todo('waiter', { dependencies: [dependency(done), dependency(open)] });

    const [, , resolved] = resolveBlocking([done, open, waiter]);

    expect(resolved.isBlocked).toBe(true);
    expect(resolved.blockedBy.map((blocker) => blocker.id)).toEqual(['open']);
  });

  it('rederives a chain in one pass, whatever the list order', () => {
    // c waits on b waits on a, with a done. b is free, c is not — completing a
    // unblocks exactly one step, and the pass must not cascade further.
    const a = todo('a', { completedAt: '2026-09-09T00:00:00.000Z' });
    const b = todo('b', { dependencies: [dependency(a)] });
    const c = todo('c', { dependencies: [dependency(b)] });

    const resolved = new Map(resolveBlocking([c, b, a]).map((row) => [row.id, row]));

    expect(resolved.get('b')?.isBlocked).toBe(false);
    expect(resolved.get('c')?.isBlocked).toBe(true);
  });

  it('leaves an already-settled list alone, so it can run twice', () => {
    const blocker = todo('blocker');
    const waiter = todo('waiter', { dependencies: [dependency(blocker)] });

    const once = resolveBlocking([blocker, waiter]);
    const twice = resolveBlocking(once);

    expect(twice).toEqual(once);
  });
});
