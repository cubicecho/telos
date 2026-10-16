import { MockedProvider } from '@apollo/client/testing';
import { render, screen } from '@testing-library/react';
import { Text } from 'react-native';
import { describe, expect, it } from 'vitest';
import { ProjectActivityDocument } from '@/lib/graphql';
import { ProjectActivityLine, useProjectActivity } from '../project-activity';

const AGENT = { __typename: 'Agent', id: 'a1', name: 'Planner' };

function liveRun(id: string, todoId: string) {
  return { __typename: 'Run', id, todoId, laneId: 'l1', cancelRequestedAt: null, agent: AGENT };
}

function activity(live: unknown[]) {
  return {
    request: { query: ProjectActivityDocument },
    variableMatcher: () => true,
    result: {
      data: {
        work: { __typename: 'AiStatus', todos: [] },
        live,
        spent: {
          __typename: 'RunAggregate',
          count: 12,
          sum: { __typename: 'RunSumAggregate', promptTokens: 30000, completionTokens: 1200, totalTokens: 31200 },
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
  it('counts the runs under way and marks the todos they work', async () => {
    render(
      <MockedProvider mocks={[activity([liveRun('r1', 't1'), liveRun('r2', 't2')])]}>
        <Page />
      </MockedProvider>,
    );
    expect(await screen.findByText('2 running · 12 runs and 31,200 tokens in 30 days')).toBeInTheDocument();
    expect(screen.getByText('Marked: t1, t2')).toBeInTheDocument();
  });

  it('says when nothing is running', async () => {
    render(
      <MockedProvider mocks={[activity([])]}>
        <Page />
      </MockedProvider>,
    );
    expect(await screen.findByText('Nothing running · 12 runs and 31,200 tokens in 30 days')).toBeInTheDocument();
    expect(screen.getByText('Marked: none')).toBeInTheDocument();
  });
});
