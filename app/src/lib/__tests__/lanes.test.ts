import { describe, expect, it } from 'vitest';
import type { CachedTodo } from '../blocking';
import type { CachedLane } from '../cache';
import { moveTodoInList, todosInLane } from '../lanes';

function lane(id: string, position: number, isDone = false): CachedLane {
  return { __typename: 'Lane', id, name: id, position, isDone };
}

const TODO = lane('todo', 0);
const DOING = lane('doing', 1);
const DONE = lane('done', 2, true);

/** A todo as the project list holds it, with only the interesting bits stated. */
function todo(id: string, position: number, at: CachedLane | null, fields: Partial<CachedTodo> = {}): CachedTodo {
  return {
    __typename: 'Todo',
    id,
    title: id,
    completedAt: null,
    position,
    isBlocked: false,
    blockedBy: [],
    dependencies: [],
    labels: [],
    lane: at,
    ...fields,
  };
}

/** The list as `id@lane#position`, which is the whole of what a move changes. */
function shape(todos: readonly CachedTodo[]): string[] {
  return todos.map((row) => `${row.id}@${row.lane?.id ?? '-'}#${row.position}`);
}

describe('moveTodoInList', () => {
  it('changes only the lane when no index is given', () => {
    const list = [todo('a', 0, TODO), todo('b', 1, TODO)];

    expect(shape(moveTodoInList(list, 'b', DOING))).toEqual(['a@todo#0', 'b@doing#1']);
  });

  it('renumbers the project when a drop names an index', () => {
    const list = [todo('a', 0, TODO), todo('b', 1, TODO), todo('c', 2, DOING)];

    expect(shape(moveTodoInList(list, 'b', TODO, 0))).toEqual(['b@todo#0', 'a@todo#1', 'c@doing#2']);
  });

  it('lands after the last card of the target lane, not after the project', () => {
    const list = [todo('a', 0, TODO), todo('b', 1, DOING), todo('c', 2, DONE, { completedAt: 'then' })];

    expect(shape(moveTodoInList(list, 'a', DOING, 5))).toEqual(['b@doing#0', 'a@doing#1', 'c@done#2']);
  });

  it('lands in an empty lane without disturbing the order', () => {
    const list = [todo('a', 0, TODO), todo('b', 1, TODO)];

    expect(shape(moveTodoInList(list, 'a', DOING, 0))).toEqual(['b@todo#0', 'a@doing#1']);
  });

  it('completes a todo dropped in the done lane and reopens one dragged out', () => {
    const list = [todo('a', 0, TODO)];

    const [completed] = moveTodoInList(list, 'a', DONE, 0, 'now');
    expect(completed.completedAt).toBe('now');

    const [reopened] = moveTodoInList([completed], 'a', TODO, 0, 'later');
    expect(reopened.completedAt).toBeNull();
  });

  it('keeps the original completion stamp when a done todo moves within its lane', () => {
    const list = [todo('a', 0, DONE, { completedAt: 'then' }), todo('b', 1, DONE, { completedAt: 'then' })];

    const [, moved] = moveTodoInList(list, 'a', DONE, 1, 'now');
    expect(moved.completedAt).toBe('then');
  });

  it('leaves a list that does not hold the todo alone', () => {
    const list = [todo('a', 0, TODO)];

    expect(shape(moveTodoInList(list, 'missing', DOING, 0))).toEqual(['a@todo#0']);
  });
});

describe('todosInLane', () => {
  it('keeps the list order within a lane', () => {
    const list = [todo('a', 0, TODO), todo('b', 1, DOING), todo('c', 2, TODO)];

    expect(todosInLane(list, 'todo').map((row) => row.id)).toEqual(['a', 'c']);
  });
});
