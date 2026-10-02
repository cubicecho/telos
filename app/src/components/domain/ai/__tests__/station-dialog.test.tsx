import { MockedProvider } from '@apollo/client/testing';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { UpdateStationDocument } from '@/lib/graphql';
import { StationDialog, successRule, toDraft, toStationSet } from '../station-dialog';

const LANES = [
  { id: 'l1', name: 'Doing', position: 0, isDone: false },
  { id: 'l2', name: 'Done', position: 1, isDone: true },
];

function station(over: Record<string, unknown> = {}) {
  return {
    __typename: 'Lane' as const,
    id: 'l1',
    agentId: 'a1',
    contract: 'work',
    prompt: null,
    onSuccessLaneId: null,
    onFailureLaneId: null,
    archiveOnSuccess: false,
    wipLimit: 1,
    maxAttempts: 3,
    ...over,
  };
}

describe('a station’s answer to success', () => {
  it('is one choice: a lane, archive, or stay', () => {
    expect(toDraft(station({ onSuccessLaneId: 'l2' })).onSuccess).toBe('l2');
    expect(toDraft(station({ archiveOnSuccess: true })).onSuccess).toBe('archive');
    expect(toDraft(station()).onSuccess).toBe('none');
  });

  it('writes archive and the arrow together, so one clears the other', () => {
    const draft = toDraft(station({ onSuccessLaneId: 'l2' }));
    expect(toStationSet(draft)).toMatchObject({ onSuccessLaneId: 'l2', archiveOnSuccess: false });
    expect(toStationSet({ ...draft, onSuccess: 'archive' })).toMatchObject({
      onSuccessLaneId: null,
      archiveOnSuccess: true,
    });
    expect(toStationSet({ ...draft, onSuccess: 'none' })).toMatchObject({
      onSuccessLaneId: null,
      archiveOnSuccess: false,
    });
  });

  it('keeps an expand station to a lane', () => {
    expect(successRule('expand', 'archive')).toContain('cannot archive');
    expect(successRule('expand', 'none')).toContain('needs somewhere');
    expect(successRule('expand', 'l2')).toBeUndefined();
    expect(successRule('work', 'archive')).toBeUndefined();
    expect(successRule('verdict', 'none')).toBeUndefined();
  });
});

describe('StationDialog', () => {
  it('shows a station that archives, and saves it as one', async () => {
    const user = userEvent.setup();
    const saved = station({ archiveOnSuccess: true });
    const update = vi.fn(() => ({ data: { updateLane: [saved] } }));
    render(
      <MockedProvider
        mocks={[
          {
            request: { query: UpdateStationDocument },
            variableMatcher: () => true,
            result: update,
          },
        ]}
      >
        <StationDialog
          open
          onOpenChange={() => {}}
          lane={LANES[0]}
          lanes={LANES}
          station={saved}
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
      set: expect.objectContaining({ onSuccessLaneId: null, archiveOnSuccess: true }),
    });
  });
});
