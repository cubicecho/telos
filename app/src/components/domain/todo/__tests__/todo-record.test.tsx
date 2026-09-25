import { MockedProvider } from '@apollo/client/testing';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { RunSummaryFieldsFragment } from '@/__generated__/graphql';
import { TodoRecordDocument } from '@/lib/graphql';
import { aiStateMock, fullRun, run, runMock } from '../../ai/__tests__/run-fixtures';
import { TodoHistory, TodoThread } from '../todo-record';

function record() {
  return {
    request: { query: TodoRecordDocument, variables: { id: 't1' } },
    result: {
      data: {
        todo: {
          __typename: 'Todo',
          id: 't1',
          thread: [
            {
              __typename: 'TodoNote',
              id: 'n1',
              kind: 'report',
              body: 'Reviewed and passed.',
              actorKind: 'agent',
              runId: 'r1',
              createdAt: '2026-09-24T10:01:00.000Z',
            },
          ],
          history: [
            {
              __typename: 'TodoEvent',
              id: 'e1',
              kind: 'create',
              fromLaneId: null,
              toLaneId: 'l1',
              fields: [],
              actorKind: 'user',
              runId: null,
              reason: null,
              at: '2026-09-24T09:00:00.000Z',
            },
            {
              __typename: 'TodoEvent',
              id: 'e2',
              kind: 'move',
              fromLaneId: 'l1',
              toLaneId: 'l2',
              fields: [],
              actorKind: 'agent',
              runId: 'r1',
              reason: 'It passed.',
              at: '2026-09-24T10:01:00.000Z',
            },
          ],
          project: {
            __typename: 'Project',
            id: 'p1',
            lanes: [
              { __typename: 'Lane', id: 'l1', name: 'Review' },
              { __typename: 'Lane', id: 'l2', name: 'Done' },
            ],
          },
        },
      },
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: MockedProvider's mock array type
function show(ui: React.ReactNode, mocks: any[]) {
  render(<MockedProvider mocks={mocks}>{ui}</MockedProvider>);
}

describe('TodoHistory', () => {
  it('puts each run among the moves, in order, and opens the run a move came from', async () => {
    const user = userEvent.setup();
    show(<TodoHistory todoId="t1" runs={[run('r1', 'ok') as RunSummaryFieldsFragment]} />, [
      aiStateMock(true, true),
      record(),
      runMock(fullRun('r1', 'ok', { output: 'Looks right.' })),
    ]);

    await screen.findByText('Moved from Review to Done');
    const items = screen.getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Created'),
      expect.stringContaining('Reviewer worked it in Review'),
      expect.stringContaining('Moved from Review to Done'),
    ]);

    await user.click(await within(items[2]).findByRole('button', { name: 'View run' }));
    expect(await screen.findByText('Looks right.')).toBeInTheDocument();
  });

  it('offers no run links while AI is off', async () => {
    show(<TodoHistory todoId="t1" />, [aiStateMock(false, false), record()]);
    expect(await screen.findByText('Moved from Review to Done')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('button', { name: 'View run' })).not.toBeInTheDocument();
  });
});

describe('TodoThread', () => {
  it('links a report to the run that wrote it', async () => {
    show(<TodoThread todoId="t1" />, [aiStateMock(true, true), record()]);
    expect(await screen.findByText('Reviewed and passed.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'View run' })).toBeInTheDocument();
  });

  it('marks the note it was opened at', async () => {
    show(<TodoThread todoId="t1" focusNoteId="n1" />, [aiStateMock(true, true), record()]);
    const note = (await screen.findByText('Reviewed and passed.')).closest('[role="listitem"]');
    expect(note).toHaveAttribute('aria-current', 'true');
  });
});
