import { MockedProvider } from '@apollo/client/testing';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { UpdateLaneAgentDocument } from '@/lib/graphql';
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
    checkCommand: null,
    checkTimeoutSeconds: null,
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

describe('a check lane', () => {
  it('reads as a check, not an agent', () => {
    const draft = toDraft(settings({ agentId: null, checkCommand: 'npm test', checkTimeoutSeconds: 90 }));
    expect(draft).toMatchObject({ agentId: 'check', checkCommand: 'npm test', checkTimeoutSeconds: '90' });
  });

  it('writes no agent, the command, and one todo at a time', () => {
    const draft = { ...toDraft(settings({ wipLimit: 3 })), agentId: 'check', checkCommand: '  npm test  ' };
    expect(toLaneAgentSet(draft)).toMatchObject({
      agentId: null,
      checkCommand: 'npm test',
      checkTimeoutSeconds: null,
      wipLimit: 1,
    });
    expect(toLaneAgentSet({ ...draft, checkTimeoutSeconds: '120' })).toMatchObject({ checkTimeoutSeconds: 120 });
  });

  it('clears the command when an agent, or nothing, takes the lane', () => {
    const draft = toDraft(settings({ agentId: null, checkCommand: 'npm test', checkTimeoutSeconds: 90 }));
    expect(toLaneAgentSet({ ...draft, agentId: 'a1' })).toMatchObject({
      agentId: 'a1',
      checkCommand: null,
      checkTimeoutSeconds: null,
    });
    expect(toLaneAgentSet({ ...draft, agentId: 'none' })).toMatchObject({ agentId: null, checkCommand: null });
  });
});

describe('LaneAgentDialog', () => {
  it('says a check runs a shell command on the runner, and saves one', async () => {
    const user = userEvent.setup();
    const saved = settings({ agentId: null, checkCommand: 'npm test' });
    const update = vi.fn(() => ({ data: { updateLane: [saved] } }));
    render(
      <MockedProvider
        mocks={[{ request: { query: UpdateLaneAgentDocument }, variableMatcher: () => true, result: update }]}
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
    expect(await screen.findByDisplayValue('npm test')).toBeInTheDocument();
    expect(screen.getByText(/shell command on the runner’s host/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Work at once (WIP limit)')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(update).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith({
      id: 'l1',
      set: expect.objectContaining({ agentId: null, checkCommand: 'npm test', wipLimit: 1 }),
    });
  });

  it('shows a lane that archives, and saves it as one', async () => {
    const user = userEvent.setup();
    const saved = settings({ archiveOnSuccess: true });
    const update = vi.fn(() => ({ data: { updateLane: [saved] } }));
    render(
      <MockedProvider
        mocks={[{ request: { query: UpdateLaneAgentDocument }, variableMatcher: () => true, result: update }]}
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
        checkCommand: null,
        checkTimeoutSeconds: null,
        onSuccessLaneId: null,
        archiveOnSuccess: true,
        onFailureLaneId: null,
        wipLimit: 1,
        maxAttempts: 3,
      },
    });
  });
});
