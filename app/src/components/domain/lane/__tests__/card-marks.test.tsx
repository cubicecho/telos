import { MockedProvider } from '@apollo/client/testing';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GraphQLError } from 'graphql';
import { describe, expect, it } from 'vitest';
import type { TodoSummary } from '@/components/domain/todo/types';
import { AiStateDocument, CardMarksDocument } from '@/lib/graphql';
import { Board } from '../board';
import { attemptsText, type CardMark } from '../card-marks';

const LANES = [
  { __typename: 'Lane' as const, id: 'l1', name: 'Todo', position: 0, isDone: false },
  { __typename: 'Lane' as const, id: 'l2', name: 'Review', position: 1, isDone: false },
];

const AI_OFF = {
  request: { query: AiStateDocument },
  result: {
    data: {
      authConfig: { __typename: 'AuthConfig', ai: false, aiAvailable: false },
      users: [{ __typename: 'User', id: 'u1', aiEnabled: false, isAdmin: false }],
    },
  },
};

function todo(id: string, title: string): TodoSummary {
  return {
    id,
    title,
    notes: null,
    acceptance: null,
    aiIgnored: false,
    parentId: null,
    dueAt: null,
    completedAt: null,
    position: 0,
    isBlocked: false,
    blockedBy: [],
    dependencies: [],
    labels: [],
    lane: { id: 'l1', name: 'Todo', position: 0, isDone: false },
  };
}

function mark(todoId: string, over: Partial<CardMark> = {}): CardMark {
  return {
    __typename: 'CardMark',
    todoId,
    notes: 0,
    lastRun: null,
    reason: null,
    runId: null,
    attempts: 0,
    maxAttempts: null,
    ...over,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: MockedProvider's result type
function board(todos: TodoSummary[], result: any) {
  render(
    <MockedProvider mocks={[AI_OFF, { request: { query: CardMarksDocument, variables: { projectId: 'p1' } }, result }]}>
      <Board projectId="p1" lanes={LANES} todos={todos} />
    </MockedProvider>,
  );
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

describe('card marks', () => {
  it('says a card has notes, in words as well as a glyph', async () => {
    board([todo('t1', 'Write it'), todo('t2', 'Plain')], { data: { cardMarks: [mark('t1', { notes: 2 })] } });
    expect(await screen.findByRole('img', { name: '2 notes' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Sent back|Run failed/ })).toBeNull();
    expect(screen.queryByText(/attempt/)).toBeNull();
  });

  it('counts one note as one', async () => {
    board([todo('t1', 'Write it')], { data: { cardMarks: [mark('t1', { notes: 1 })] } });
    expect(await screen.findByRole('img', { name: '1 note' })).toBeTruthy();
  });

  it('says a reviewer sent it back, and gives the reason on a press', async () => {
    board([todo('t1', 'Write it')], {
      data: {
        cardMarks: [
          mark('t1', {
            lastRun: 'rejected',
            reason: 'FAIL: the second paragraph is missing.',
            runId: 'r1',
            attempts: 1,
            maxAttempts: 3,
          }),
        ],
      },
    });
    const button = await screen.findByRole('button', { name: 'Sent back: why “Write it” came back' });
    expect(within(button).getByText('Sent back')).toBeTruthy();
    expect(screen.queryByText(/second paragraph/)).toBeNull();
    expect(screen.getByText('1 failed attempt, limit 3')).toBeTruthy();

    await userEvent.setup().click(button);
    expect(await screen.findByText('A reviewer sent it back')).toBeTruthy();
    expect(screen.getByText('FAIL: the second paragraph is missing.')).toBeTruthy();
  });

  it('says a run failed, apart from being sent back', async () => {
    board([todo('t1', 'Write it')], {
      data: { cardMarks: [mark('t1', { lastRun: 'errored', reason: 'The endpoint refused.', attempts: 2 })] },
    });
    const button = await screen.findByRole('button', { name: 'Run failed: why “Write it” came back' });
    expect(screen.queryByRole('button', { name: /Sent back/ })).toBeNull();
    expect(screen.getByText('2 failed attempts')).toBeTruthy();

    await userEvent.setup().click(button);
    expect(await screen.findByText('The last run did not finish')).toBeTruthy();
    expect(screen.getByText('The endpoint refused.')).toBeTruthy();
  });

  it('says so when a run left no reason', async () => {
    board([todo('t1', 'Write it')], { data: { cardMarks: [mark('t1', { lastRun: 'rejected', attempts: 1 })] } });
    // By its whole name: the draggable card is a button too, named by what it holds.
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Sent back: why “Write it” came back' }));
    expect(await screen.findByText('The reviewer gave no reason.')).toBeTruthy();
  });

  it('draws the cards without marks when the marks cannot be read', async () => {
    board([todo('t1', 'Write it')], { errors: [new GraphQLError('No.')] });
    await settle();
    expect(screen.getByText('Write it')).toBeTruthy();
    expect(screen.queryByRole('img', { name: /note/ })).toBeNull();
    expect(screen.queryByText('No.')).toBeNull();
  });
});

describe('attemptsText', () => {
  it('says nothing when no attempt failed', () => {
    expect(attemptsText(mark('t1'))).toBeNull();
  });

  it('counts against the lane’s limit when there is one', () => {
    expect(attemptsText(mark('t1', { attempts: 3, maxAttempts: 3 }))).toBe('3 failed attempts, limit 3');
    expect(attemptsText(mark('t1', { attempts: 1 }))).toBe('1 failed attempt');
  });
});
