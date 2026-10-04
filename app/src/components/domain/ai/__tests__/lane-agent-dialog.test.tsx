import { MockedProvider } from '@apollo/client/testing';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { UpdateStationDocument } from '@/lib/graphql';
import { LaneAgentDialog, toDraft, toLaneAgentSet } from '../lane-agent-dialog';

const LANES = [
  { id: 'l1', name: 'Doing', position: 0, isDone: false },
  { id: 'l2', name: 'Done', position: 1, isDone: true },
];

function settings(over: Record<string, unknown> = {}) {
  return {
    __typename: 'Lane' as const,
    id: 'l1',
    agentId: 'a1',
    onSuccessLaneId: null,
    onFailureLaneId: null,
    archiveOnSuccess: false,
    wipLimit: 1,
    maxAttempts: 3,
    ...over,
  };
}

describe('a lane’s success route', () => {
  it('is one choice: a lane, archive, or stay', () => {
    expect(toDraft(settings({ onSuccessLaneId: 'l2' })).onSuccess).toBe('l2');
    expect(toDraft(settings({ archiveOnSuccess: true })).onSuccess).toBe('archive');
    expect(toDraft(settings()).onSuccess).toBe('none');
  });

  it('writes archive and the route together, so one clears the other', () => {
    const draft = toDraft(settings({ onSuccessLaneId: 'l2' }));
    expect(toLaneAgentSet(draft)).toMatchObject({ onSuccessLaneId: 'l2', archiveOnSuccess: false });
    expect(toLaneAgentSet({ ...draft, onSuccess: 'archive' })).toMatchObject({
      onSuccessLaneId: null,
      archiveOnSuccess: true,
    });
    expect(toLaneAgentSet({ ...draft, onSuccess: 'none' })).toMatchObject({
      onSuccessLaneId: null,
      archiveOnSuccess: false,
    });
  });
});

describe('LaneAgentDialog', () => {
  it('shows a lane that archives, and saves it as one', async () => {
    const user = userEvent.setup();
    const saved = settings({ archiveOnSuccess: true });
    const update = vi.fn(() => ({ data: { updateLane: [saved] } }));
    render(
      <MockedProvider
        mocks={[{ request: { query: UpdateStationDocument }, variableMatcher: () => true, result: update }]}
      >
        <LaneAgentDialog
          open
          onOpenChange={() => {}}
          lane={LANES[0]}
          lanes={LANES}
          settings={saved}
          agents={[{ id: 'a1', name: 'Worker' }]}
        />
      </MockedProvider>,
    );
    // The select's own element holds the choice; its trigger repeats the label.
    expect(await screen.findByDisplayValue('Archive it — done, and off the board')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(update).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith({
      id: 'l1',
      set: {
        agentId: 'a1',
        onSuccessLaneId: null,
        archiveOnSuccess: true,
        onFailureLaneId: null,
        wipLimit: 1,
        maxAttempts: 3,
      },
    });
  });
});
