import { MockedProvider } from '@apollo/client/testing';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GraphQLError } from 'graphql';
import { describe, expect, it } from 'vitest';
import type { RunSummaryFieldsFragment } from '@/__generated__/graphql';
import { DeleteTodoNoteDocument, EditTodoNoteDocument, TodoRecordDocument } from '@/lib/graphql';
import { aiStateMock, fullRun, run, runMock } from '../../ai/__tests__/run-fixtures';
import { TodoHistory, TodoThread } from '../todo-record';

const REPORT = {
  __typename: 'TodoNote',
  id: 'n1',
  kind: 'report',
  body: 'Reviewed and passed.',
  actorKind: 'agent',
  runId: 'r1',
  createdAt: '2026-09-24T10:01:00.000Z',
  editedAt: null,
};

/** A plain note, the person's own unless `extra` says who else signed it. */
function plainNote(id: string, body: string, extra: Record<string, unknown> = {}) {
  return {
    __typename: 'TodoNote',
    id,
    kind: 'note',
    body,
    actorKind: 'user',
    runId: null,
    createdAt: '2026-09-24T09:30:00.000Z',
    editedAt: null,
    ...extra,
  };
}

function record(aiEnabled = true, thread: Array<Record<string, unknown>> = [REPORT]) {
  return {
    request: { query: TodoRecordDocument, variables: { id: 't1' } },
    result: {
      data: {
        todo: {
          __typename: 'Todo',
          id: 't1',
          thread,
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
            aiEnabled,
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

  it('offers no run links on a project with AI off, even for notes a run wrote', async () => {
    show(<TodoThread todoId="t1" />, [aiStateMock(true, true), record(false)]);
    expect(await screen.findByText('Reviewed and passed.')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('button', { name: 'View run' })).not.toBeInTheDocument();
  });

  it('offers edit on the person’s own notes only, and delete on plain notes only', async () => {
    show(<TodoThread todoId="t1" />, [
      aiStateMock(true, true),
      record(true, [plainNote('n2', 'Mine.'), plainNote('n3', 'From outside.', { actorKind: 'apiKey' }), REPORT]),
    ]);
    const [mine, outside, report] = await screen.findAllByRole('listitem');
    expect(within(mine).getByRole('button', { name: 'Edit note' })).toBeInTheDocument();
    expect(within(mine).getByRole('button', { name: 'Delete note' })).toBeInTheDocument();
    expect(within(outside).queryByRole('button', { name: 'Edit note' })).not.toBeInTheDocument();
    expect(within(outside).getByRole('button', { name: 'Delete note' })).toBeInTheDocument();
    expect(within(report).queryByRole('button', { name: 'Edit note' })).not.toBeInTheDocument();
    expect(within(report).queryByRole('button', { name: 'Delete note' })).not.toBeInTheDocument();
  });

  it('saves an edit, and shows the note as edited with the time', async () => {
    const user = userEvent.setup();
    const edited = plainNote('n2', 'Mind the second paragraph.', { editedAt: '2026-09-24T11:00:00.000Z' });
    show(<TodoThread todoId="t1" />, [
      aiStateMock(true, true),
      record(true, [plainNote('n2', 'Mind the second paragrpah.')]),
      {
        request: { query: EditTodoNoteDocument, variables: { id: 'n2', body: 'Mind the second paragraph.' } },
        result: { data: { editTodoNote: edited } },
      },
    ]);
    const note = await screen.findByRole('listitem');
    expect(note).not.toHaveTextContent('edited');

    await user.click(within(note).getByRole('button', { name: 'Edit note' }));
    // Why the edit will not reach an agent already at work.
    expect(await within(note).findByText(/reaches only the runs that start after it/)).toBeInTheDocument();
    const box = within(note).getByRole('textbox', { name: 'Note' });
    expect(box).toHaveValue('Mind the second paragrpah.');
    await user.clear(box);
    await user.type(box, '  Mind the second paragraph. ');
    await user.click(within(note).getByRole('button', { name: 'Save note' }));

    expect(await within(note).findByText('Mind the second paragraph.')).toBeInTheDocument();
    expect(note).toHaveTextContent(/· edited /);
    expect(within(note).queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('leaves the note as it was when the edit is cancelled, and says nothing of runs with AI off', async () => {
    const user = userEvent.setup();
    show(<TodoThread todoId="t1" />, [aiStateMock(false, false), record(false, [plainNote('n2', 'Mine.')])]);
    const note = await screen.findByRole('listitem');
    await user.click(within(note).getByRole('button', { name: 'Edit note' }));
    await user.type(within(note).getByRole('textbox', { name: 'Note' }), ' More.');
    expect(within(note).queryByText(/runs that start after/)).not.toBeInTheDocument();
    await user.click(within(note).getByRole('button', { name: 'Cancel' }));
    expect(within(note).getByText('Mine.')).toBeInTheDocument();
    expect(within(note).queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('keeps the editor open and says why when the server refuses an edit', async () => {
    const user = userEvent.setup();
    show(<TodoThread todoId="t1" />, [
      aiStateMock(true, true),
      record(true, [plainNote('n2', 'Mine.')]),
      {
        request: { query: EditTodoNoteDocument, variables: { id: 'n2', body: 'Mine, again.' } },
        result: { errors: [new GraphQLError('Note not found')] },
      },
    ]);
    const note = await screen.findByRole('listitem');
    await user.click(within(note).getByRole('button', { name: 'Edit note' }));
    const box = within(note).getByRole('textbox', { name: 'Note' });
    await user.clear(box);
    await user.type(box, 'Mine, again.');
    await user.click(within(note).getByRole('button', { name: 'Save note' }));
    expect(await screen.findByText(/Note not found/)).toBeInTheDocument();
    expect(within(note).getByRole('textbox', { name: 'Note' })).toHaveValue('Mine, again.');
  });

  it('deletes a note and reads the thread again', async () => {
    const user = userEvent.setup();
    show(<TodoThread todoId="t1" />, [
      aiStateMock(true, true),
      record(true, [plainNote('n2', 'Mine.')]),
      {
        request: { query: DeleteTodoNoteDocument, variables: { id: 'n2' } },
        result: { data: { deleteTodoNote: { __typename: 'TodoNote', id: 'n2' } } },
      },
      record(true, []),
    ]);
    await user.click(await screen.findByRole('button', { name: 'Delete note' }));
    expect(await screen.findByText('No notes yet.')).toBeInTheDocument();
    expect(screen.queryByText('Mine.')).not.toBeInTheDocument();
  });
});
