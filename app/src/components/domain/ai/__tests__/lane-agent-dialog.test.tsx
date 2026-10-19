import { MockedProvider } from '@apollo/client/testing';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AgentDefaultsDocument, UpdateLaneAgentDocument } from '@/lib/graphql';
import { LaneAgentDialog, sameModelReviews, toDraft, toLaneAgentSet } from '../lane-agent-dialog';

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

// Doing works a todo and passes it to Review; Review fails it back to Doing.
const LOOP_LANES = [
  { id: 'l1', name: 'Doing', position: 0, isDone: false },
  { id: 'l2', name: 'Review', position: 1, isDone: false },
  { id: 'l3', name: 'Done', position: 2, isDone: true },
];
const DOING = settings({ id: 'l1', agentId: 'worker', onSuccessLaneId: 'l2' });
const REVIEW = settings({ id: 'l2', agentId: 'reviewer', onSuccessLaneId: 'l3', onFailureLaneId: 'l1' });

describe('a review loop on one model', () => {
  const models: Record<string, string | null> = { worker: 'qwen3:14b', reviewer: 'qwen3:14b', other: 'llama3:8b' };
  const modelOf = (agentId: string) => models[agentId] ?? null;

  it('is found from the reviewer’s side and from the worker’s', () => {
    const found = [{ reviewer: 'Review', worker: 'Doing', model: 'qwen3:14b' }];
    expect(sameModelReviews('l2', toDraft(REVIEW), [DOING, REVIEW], LOOP_LANES, modelOf)).toEqual(found);
    expect(sameModelReviews('l1', toDraft(DOING), [DOING, REVIEW], LOOP_LANES, modelOf)).toEqual(found);
  });

  it('follows the form rather than what is saved', () => {
    const draft = { ...toDraft(REVIEW), agentId: 'other' };
    expect(sameModelReviews('l2', draft, [DOING, REVIEW], LOOP_LANES, modelOf)).toEqual([]);
    const unhooked = { ...toDraft(REVIEW), onFailureLaneId: 'none' };
    expect(sameModelReviews('l2', unhooked, [DOING, REVIEW], LOOP_LANES, modelOf)).toEqual([]);
  });

  it('is no loop when the failure route goes to a lane that does not feed this one', () => {
    const elsewhere = settings({ id: 'l1', agentId: 'worker', onSuccessLaneId: 'l3' });
    expect(sameModelReviews('l2', toDraft(REVIEW), [elsewhere, REVIEW], LOOP_LANES, modelOf)).toEqual([]);
  });

  it('says nothing about a lane with no model to compare', () => {
    expect(sameModelReviews('l2', toDraft(REVIEW), [DOING, REVIEW], LOOP_LANES, () => null)).toEqual([]);
  });
});

describe('LaneAgentDialog on a review loop', () => {
  const RESOLVED = {
    __typename: 'ResolvedAgentSettings',
    baseUrl: '',
    model: 'qwen3:14b',
    temperature: 0.7,
    maxTokens: 0,
    contextLength: 0,
    maxToolIterations: 20,
    toolDiscovery: false,
    toolSelectModel: '',
    reasoningEffort: '',
    requestTimeoutSeconds: null,
    maxRetries: 0,
  };
  const defaults = {
    request: { query: AgentDefaultsDocument },
    result: {
      data: {
        agentDefaults: {
          __typename: 'AgentDefaults',
          id: 'u1',
          baseUrl: null,
          model: 'qwen3:14b',
          temperature: null,
          maxTokens: null,
          contextLength: null,
          maxToolIterations: null,
          toolDiscovery: null,
          toolSelectModel: null,
          reasoningEffort: null,
          requestTimeoutSeconds: null,
          maxRetries: null,
          hasApiKey: false,
          resolved: RESOLVED,
          builtIn: { ...RESOLVED, model: '' },
        },
      },
    },
  };

  function renderReview(agents: Array<{ id: string; name: string; model: string | null }>) {
    render(
      <MockedProvider mocks={[defaults]}>
        <LaneAgentDialog
          open
          onOpenChange={() => {}}
          lane={LOOP_LANES[1]}
          lanes={LOOP_LANES}
          settings={REVIEW}
          laneAgents={[DOING, REVIEW]}
          agents={agents}
        />
      </MockedProvider>,
    );
  }

  it('warns when the reviewer inherits the model the worker names', async () => {
    renderReview([
      { id: 'worker', name: 'Worker', model: 'qwen3:14b' },
      { id: 'reviewer', name: 'Reviewer', model: null },
    ]);
    expect(await screen.findByText('The reviewer uses the worker’s model')).toBeInTheDocument();
    expect(screen.getByText(/Review rules on Doing’s work with qwen3:14b/)).toBeInTheDocument();
  });

  it('says nothing when the two use different models', async () => {
    renderReview([
      { id: 'worker', name: 'Worker', model: 'qwen3:14b' },
      { id: 'reviewer', name: 'Reviewer', model: 'llama3:8b' },
    ]);
    expect(await screen.findByDisplayValue('Reviewer')).toBeInTheDocument();
    expect(screen.queryByText('The reviewer uses the worker’s model')).not.toBeInTheDocument();
  });
});
