import { describe, expect, it } from 'vitest';
import type { TodoSummary } from '@/components/domain/todo/types';
import { filterTodos, isFiltering, labelsInUse, NO_FILTER, type TodoFilter } from '../filter-todos';

/** A todo as the project screen holds it, with only the interesting bits stated. */
function todo(id: string, fields: Partial<TodoSummary> = {}): TodoSummary {
  return {
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

const URGENT = { id: 'l1', name: 'urgent', color: '#b91c1c' };
const HOME = { id: 'l2', name: 'Home', color: '#0f766e' };

function filter(fields: Partial<TodoFilter> = {}): TodoFilter {
  return { ...NO_FILTER, ...fields };
}

function ids(todos: readonly TodoSummary[]): string[] {
  return todos.map((t) => t.id);
}

describe('isFiltering', () => {
  it('is false for the empty filter, and for a sort on its own', () => {
    expect(isFiltering(NO_FILTER)).toBe(false);
    // Sorting is not narrowing: an ordered list still shows everything, so it
    // must not make the screen say "3 of 40".
    expect(isFiltering(filter({ sort: 'due' }))).toBe(false);
    expect(isFiltering(filter({ text: '   ' }))).toBe(false);
  });

  it('is true once something narrows', () => {
    expect(isFiltering(filter({ text: 'tap' }))).toBe(true);
    expect(isFiltering(filter({ labelId: 'l1' }))).toBe(true);
  });
});

describe('filtering by text', () => {
  const todos = [
    todo('a', { title: 'Replace the TAP' }),
    todo('b', { title: 'Call the plumber', notes: 'About the tap' }),
    todo('c', { title: 'Buy bread' }),
  ];

  it('matches the title and the notes, case-insensitively', () => {
    expect(ids(filterTodos(todos, filter({ text: 'tap' })))).toEqual(['a', 'b']);
  });

  it('ignores surrounding whitespace, and an empty query keeps everything', () => {
    expect(ids(filterTodos(todos, filter({ text: '  tap  ' })))).toEqual(['a', 'b']);
    expect(ids(filterTodos(todos, NO_FILTER))).toEqual(['a', 'b', 'c']);
  });

  it('matches nothing rather than everything when nothing matches', () => {
    expect(filterTodos(todos, filter({ text: 'zebra' }))).toEqual([]);
  });
});

describe('filtering by label', () => {
  const todos = [todo('a', { labels: [URGENT] }), todo('b', { labels: [URGENT, HOME] }), todo('c', { labels: [] })];

  it('keeps the todos carrying it', () => {
    expect(ids(filterTodos(todos, filter({ labelId: URGENT.id })))).toEqual(['a', 'b']);
    expect(ids(filterTodos(todos, filter({ labelId: HOME.id })))).toEqual(['b']);
  });

  it('combines with text rather than replacing it', () => {
    const withTitles = [
      todo('a', { title: 'Fix the tap', labels: [URGENT] }),
      todo('b', { title: 'Fix the door', labels: [URGENT] }),
      todo('c', { title: 'Fix the tap', labels: [HOME] }),
    ];
    expect(ids(filterTodos(withTitles, filter({ text: 'tap', labelId: URGENT.id })))).toEqual(['a']);
  });
});

describe('sorting by due date', () => {
  it('puts the soonest first and the undated last', () => {
    const todos = [
      todo('none', { position: 0 }),
      todo('later', { position: 1, dueAt: '2026-12-01T09:00:00.000Z' }),
      todo('sooner', { position: 2, dueAt: '2026-09-20T09:00:00.000Z' }),
    ];
    // Undated at the end, not the start: "no due date" is not "due at the
    // beginning of time", and a todo nobody scheduled should not lead.
    expect(ids(filterTodos(todos, filter({ sort: 'due' })))).toEqual(['sooner', 'later', 'none']);
  });

  it('breaks ties on position, so the manual order decides', () => {
    const same = '2026-09-20T09:00:00.000Z';
    const todos = [todo('second', { position: 2, dueAt: same }), todo('first', { position: 1, dueAt: same })];
    expect(ids(filterTodos(todos, filter({ sort: 'due' })))).toEqual(['first', 'second']);
  });

  it('orders undated todos among themselves by position', () => {
    const todos = [todo('second', { position: 2 }), todo('first', { position: 1 })];
    expect(ids(filterTodos(todos, filter({ sort: 'due' })))).toEqual(['first', 'second']);
  });

  it('leaves the given order alone under the manual sort', () => {
    const todos = [todo('b', { position: 5 }), todo('a', { position: 1 })];
    // Manual means "as the query returned it" — the server already ordered by
    // position, and re-sorting here would be a second opinion about it.
    expect(ids(filterTodos(todos, NO_FILTER))).toEqual(['b', 'a']);
  });

  it('does not mutate the array it was given', () => {
    const todos = [todo('b', { dueAt: '2026-12-01T09:00:00.000Z' }), todo('a', { dueAt: '2026-09-20T09:00:00.000Z' })];
    filterTodos(todos, filter({ sort: 'due' }));
    expect(ids(todos)).toEqual(['b', 'a']);
  });
});

describe('labelsInUse', () => {
  it('lists each label once, by name', () => {
    const todos = [todo('a', { labels: [URGENT, HOME] }), todo('b', { labels: [URGENT] })];
    expect(labelsInUse(todos).map((label) => label.name)).toEqual(['Home', 'urgent']);
  });

  it('is empty when nothing is labelled, so the picker can say so', () => {
    expect(labelsInUse([todo('a')])).toEqual([]);
  });
});
