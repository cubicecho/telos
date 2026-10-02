import { MockedProvider } from '@apollo/client/testing';
import { render, screen } from '@testing-library/react';
import { Text } from 'react-native';
import { describe, expect, it } from 'vitest';
import { ProjectActivityDocument } from '@/lib/graphql';
import { ProjectActivityLine, useProjectActivity } from '../project-activity';

const AGENT = { __typename: 'Agent', id: 'a1', name: 'Planner' };

function liveRun(id: string, kind: string, todoId: string | null) {
  return { __typename: 'Run', id, kind, todoId, laneId: todoId ? 'l1' : null, cancelRequestedAt: null, agent: AGENT };
}

function activity(live: unknown[], drafts: { count: number; totalTokens: number }) {
  return {
    request: { query: ProjectActivityDocument },
    variableMatcher: () => true,
    result: {
      data: {
        stations: { __typename: 'AiStatus', todos: [] },
        live,
        spent: {
          __typename: 'RunAggregate',
          count: 12,
          sum: { __typename: 'RunSumAggregate', promptTokens: 30000, completionTokens: 1200, totalTokens: 31200 },
        },
        draftSpent: {
          __typename: 'RunAggregate',
          count: drafts.count,
          sum: drafts.count > 0 ? { __typename: 'RunSumAggregate', totalTokens: drafts.totalTokens } : null,
        },
      },
    },
  };
}

/** Holds the project's activity the way the project page does, and says which todos are marked. */
function Page() {
  const held = useProjectActivity('p1');
  return (
    <>
      <ProjectActivityLine activity={held} />
      <Text>Marked: {[...held.live.keys()].join(', ') || 'none'}</Text>
    </>
  );
}

describe('useProjectActivity', () => {
  it('counts a draft’s reply as running and in the spend, as a draft’s, and marks no todo with it', async () => {
    render(
      <MockedProvider
        mocks={[activity([liveRun('r1', 'todo', 't1'), liveRun('r2', 'draft', null)], { count: 4, totalTokens: 900 })]}
      >
        <Page />
      </MockedProvider>,
    );
    expect(
      await screen.findByText(
        '2 running, 1 draft reply · 12 runs and 31,200 tokens in 30 days, 4 draft replies among them',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Marked: t1')).toBeInTheDocument();
  });

  it('says nothing of drafts when there were none', async () => {
    render(
      <MockedProvider mocks={[activity([], { count: 0, totalTokens: 0 })]}>
        <Page />
      </MockedProvider>,
    );
    expect(await screen.findByText('Nothing running · 12 runs and 31,200 tokens in 30 days')).toBeInTheDocument();
    expect(screen.getByText('Marked: none')).toBeInTheDocument();
  });
});
