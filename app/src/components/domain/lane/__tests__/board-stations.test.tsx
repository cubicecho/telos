import { MockedProvider } from '@apollo/client/testing';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AiStateDocument, ProjectStationsDocument } from '@/lib/graphql';
import { Board } from '../board';

const LANES = [
  { __typename: 'Lane' as const, id: 'l1', name: 'Todo', position: 0, isDone: false },
  { __typename: 'Lane' as const, id: 'l2', name: 'Review', position: 1, isDone: false },
];

function aiState(instance: boolean, account: boolean) {
  return {
    request: { query: AiStateDocument },
    result: {
      data: {
        authConfig: { __typename: 'AuthConfig', ai: instance },
        users: [{ __typename: 'User', id: 'u1', aiEnabled: account }],
      },
    },
  };
}

function station(id: string, agentId: string | null) {
  return {
    __typename: 'Lane',
    id,
    agentId,
    contract: 'verdict',
    prompt: null,
    onSuccessLaneId: null,
    onFailureLaneId: null,
    wipLimit: 1,
    maxAttempts: 3,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: MockedProvider's mock array type
function board(mocks: any[], aiEnabled: boolean) {
  render(
    <MockedProvider mocks={mocks}>
      <Board projectId="p1" aiEnabled={aiEnabled} lanes={LANES} todos={[]} />
    </MockedProvider>,
  );
}

async function laneMenu(lane: string) {
  await userEvent.setup().click(screen.getByRole('button', { name: `${lane} lane actions` }));
  return screen.findByRole('menuitem', { name: 'Rename' });
}

describe('Board stations', () => {
  it('offers no station settings while the instance has AI off', async () => {
    const stations = vi.fn();
    board(
      [
        aiState(false, false),
        { request: { query: ProjectStationsDocument, variables: { projectId: 'p1' } }, result: stations },
      ],
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    await laneMenu('Review');
    expect(screen.queryByRole('menuitem', { name: 'Station…' })).not.toBeInTheDocument();
    expect(screen.queryByText('Station')).not.toBeInTheDocument();
    expect(stations).not.toHaveBeenCalled();
  });

  it('offers none while the project has AI off, even with the account on', async () => {
    board([aiState(true, true)], false);
    await new Promise((resolve) => setTimeout(resolve, 20));

    await laneMenu('Review');
    expect(screen.queryByRole('menuitem', { name: 'Station…' })).not.toBeInTheDocument();
  });

  it('marks a station, and offers its settings, with AI on throughout', async () => {
    board(
      [
        aiState(true, true),
        {
          request: { query: ProjectStationsDocument, variables: { projectId: 'p1' } },
          result: {
            data: {
              lanes: [station('l1', null), station('l2', 'a1')],
              agents: [{ __typename: 'Agent', id: 'a1', name: 'Reviewer' }],
            },
          },
        },
      ],
      true,
    );

    expect(await screen.findByLabelText('Station, worked by Reviewer')).toBeInTheDocument();
    // Only the lane with an agent is one.
    expect(screen.getAllByText('Station')).toHaveLength(1);

    await laneMenu('Review');
    expect(screen.getByRole('menuitem', { name: 'Station…' })).toBeInTheDocument();
  });
});
