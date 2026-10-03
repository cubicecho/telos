import { MockedProvider } from '@apollo/client/testing';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TodoLinkDocument } from '@/lib/graphql';
import TodoLinkScreen from '../../../../../app/(app)/todos/[id]';

// A todo's own link (`Todo.url`) goes to its project with the todo open, or to
// the project's Archived view when the todo is archived.

const params = vi.hoisted(() => ({ id: 't1' }));
vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: { pathname: string; params: Record<string, string> } }) =>
    `Redirected to ${href.pathname} ${JSON.stringify(href.params)}`,
  router: { replace: vi.fn() },
  useLocalSearchParams: () => params,
}));

function linkTo(todos: Array<{ id: string; projectId: string; archivedAt: string | null }>) {
  return {
    request: { query: TodoLinkDocument, variables: { id: 't1' } },
    result: { data: { todos: todos.map((todo) => ({ __typename: 'Todo' as const, ...todo })) } },
  };
}

function open(mock: ReturnType<typeof linkTo>) {
  render(
    <MockedProvider mocks={[mock]}>
      <TodoLinkScreen />
    </MockedProvider>,
  );
}

describe('a todo’s link', () => {
  it('opens the todo in its project', async () => {
    open(linkTo([{ id: 't1', projectId: 'p1', archivedAt: null }]));
    expect(await screen.findByText('Redirected to /projects/[id] {"id":"p1","todo":"t1"}')).toBeTruthy();
  });

  it('lands on the Archived view for an archived todo', async () => {
    open(linkTo([{ id: 't1', projectId: 'p1', archivedAt: '2026-10-01T00:00:00.000Z' }]));
    expect(await screen.findByText('Redirected to /projects/[id] {"id":"p1","view":"archived"}')).toBeTruthy();
  });

  it('says so when the todo is not there', async () => {
    open(linkTo([]));
    expect(await screen.findByText('Todo not found')).toBeTruthy();
  });
});
