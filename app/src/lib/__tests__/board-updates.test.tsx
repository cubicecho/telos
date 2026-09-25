import { useQuery } from '@apollo/client';
import { MockedProvider } from '@apollo/client/testing';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useBoardUpdates } from '@/lib/board-updates';
import { BoardChangedDocument, ProjectDocument } from '@/lib/graphql';

const project = (name: string) => ({
  request: { query: ProjectDocument, variables: { id: 'p1' } },
  result: {
    data: {
      project: {
        __typename: 'Project',
        id: 'p1',
        name,
        description: null,
        createdAt: '2026-09-25T10:00:00.000Z',
        todoCount: 0,
        openTodoCount: 0,
        aiEnabled: false,
        labels: [],
      },
    },
  },
});

function Watched() {
  useBoardUpdates('p1', 10);
  const { data } = useQuery(ProjectDocument, { variables: { id: 'p1' } });
  return <p>{data?.project?.name ?? 'loading'}</p>;
}

describe('useBoardUpdates', () => {
  it('refetches what is on screen when the board changes', async () => {
    render(
      <MockedProvider
        mocks={[
          project('Before'),
          {
            request: { query: BoardChangedDocument, variables: { projectId: 'p1' } },
            result: { data: { boardChanged: { __typename: 'BoardChange', projectId: 'p1', table: 'todos' } } },
            delay: 50,
          },
          project('After'),
        ]}
      >
        <Watched />
      </MockedProvider>,
    );
    expect(await screen.findByText('Before')).toBeInTheDocument();
    expect(await screen.findByText('After')).toBeInTheDocument();
  });
});
