import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Platform, Text, View } from 'react-native';
import type { RunSummaryFieldsFragment, TodoNoteFieldsFragment } from '@/__generated__/graphql';
import { RunDialog } from '@/components/domain/ai/run-dialog';
import { describeRun, RunStatusBadge } from '@/components/domain/ai/run-log';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Pencil, Trash2 } from '@/components/ui/icons';
import { LoadState } from '@/components/ui/load-failure';
import { Textarea } from '@/components/ui/textarea';
import { useAi } from '@/lib/ai';
import { formatTimestamp } from '@/lib/dates';
import { describeError } from '@/lib/errors';
import {
  CreateTodoNoteDocument,
  DeleteTodoNoteDocument,
  EditTodoNoteDocument,
  TodoRecordDocument,
} from '@/lib/graphql';
import { cn } from '@/lib/utils';

// A todo's record: the notes left on it and the history the database keeps of
// it. Neither needs AI — a person's own notes and moves are recorded the same —
// so both are drawn whatever the switches say. What AI adds is more authors.
//
// The two tabs read one query. `cache-and-network` because the history is
// written by a trigger the client never sees: a todo moved a moment ago on the
// board has an event the cache cannot know about.

/** Who wrote a line, as a reader wants it put. */
const ACTOR_NAMES: Record<string, string> = {
  user: 'You',
  apiKey: 'An AI client',
  agent: 'An agent',
  system: 'Telos',
};

function actorName(kind: string): string {
  return ACTOR_NAMES[kind] ?? kind;
}

/**
 * "View run", on a line a run wrote, while AI is on to read runs by. A run
 * deleted since leaves the id behind, and the dialog says so.
 */
/**
 * A link to the run a note or move came from, while AI is on for the account
 * and for the todo's project: with the project's off, its runs are not shown.
 */
function ViewRun({ runId, projectAi }: { runId: string | null | undefined; projectAi: boolean }) {
  const ai = useAi();
  const [open, setOpen] = useState(false);
  if (!ai.on || !projectAi || !runId) return null;
  return (
    <>
      <Button variant="link" size="xs" className="h-auto self-start px-0" onPress={() => setOpen(true)}>
        View run
      </Button>
      {open ? <RunDialog runId={runId} open onOpenChange={setOpen} /> : null}
    </>
  );
}

function useTodoRecord(todoId: string) {
  return useQuery(TodoRecordDocument, { variables: { id: todoId }, fetchPolicy: 'cache-and-network' });
}

/**
 * Brings a note into view, where the platform can: on the web a `View` is its
 * element. Native opens the thread at the top, with the note marked.
 */
function scrollToNote(node: View | null) {
  if (Platform.OS !== 'web' || !node) return;
  (node as unknown as HTMLElement).scrollIntoView?.({ block: 'nearest' });
}

/** A note someone wrote, as against a report or a verdict a run returned. */
const PLAIN_NOTE = 'note';

/** Who signs what a person writes here. */
const SIGNED_BY_PERSON = 'user';

// Which notes offer what. The server decides (resolvers/notes.ts); this only
// keeps a button off a note it would refuse. A person rewrites what they wrote,
// and may clear any plain note off their board. What a run reported stays.

function canEdit(note: TodoNoteFieldsFragment): boolean {
  return note.kind === PLAIN_NOTE && note.actorKind === SIGNED_BY_PERSON;
}

function canDelete(note: TodoNoteFieldsFragment): boolean {
  return note.kind === PLAIN_NOTE;
}

/**
 * One note on the thread: who wrote it and when, whether it was edited since,
 * and the buttons its reader may use on it.
 *
 * @param props.note - The note.
 * @param props.focused - Whether to mark it and bring it into view.
 * @param props.projectAi - Whether the todo's project has AI on.
 * @param props.onEdit - Saves a new body. Resolves true when it was saved.
 * @param props.onDelete - Removes the note.
 */
function ThreadNote({
  note,
  focused,
  projectAi,
  onEdit,
  onDelete,
}: {
  note: TodoNoteFieldsFragment;
  focused: boolean;
  projectAi: boolean;
  onEdit: (id: string, body: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
}) {
  const ai = useAi();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (draft === null) {
      return;
    }
    setSaving(true);
    const saved = await onEdit(note.id, draft.trim());
    setSaving(false);
    if (saved) {
      setDraft(null);
    }
  }

  return (
    <View
      role="listitem"
      ref={focused ? scrollToNote : undefined}
      aria-current={focused ? true : undefined}
      className={cn('gap-1 rounded-lg border px-3 py-2', focused ? 'border-primary bg-accent' : 'border-border')}
    >
      <View className="flex-row items-center gap-2">
        <Text className="flex-1 text-muted-foreground text-xs">
          {actorName(note.actorKind)} · {formatTimestamp(note.createdAt)}
          {note.editedAt ? ` · edited ${formatTimestamp(note.editedAt)}` : ''}
        </Text>
        {note.kind === PLAIN_NOTE ? null : (
          <Badge variant="secondary" className="self-center">
            {note.kind}
          </Badge>
        )}
        {canEdit(note) && draft === null ? (
          <Button variant="ghost" size="icon-sm" aria-label="Edit note" onPress={() => setDraft(note.body)}>
            <Pencil className="h-4 w-4" />
          </Button>
        ) : null}
        {canDelete(note) ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="hover:text-destructive"
            aria-label="Delete note"
            onPress={() => onDelete(note.id)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        ) : null}
      </View>
      {draft === null ? (
        <Text className="text-foreground text-sm">{note.body}</Text>
      ) : (
        <View className="gap-2">
          <Textarea value={draft} onChangeText={setDraft} aria-label="Note" rows={3} />
          {/* The thread is read when a run is claimed, so one under way has the old wording. */}
          {ai.on && projectAi ? (
            <Text className="text-muted-foreground text-xs">
              An edit reaches only the runs that start after it. A run already under way keeps what it read.
            </Text>
          ) : null}
          <View className="flex-row justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={saving} onPress={() => setDraft(null)}>
              Cancel
            </Button>
            <Button size="sm" disabled={saving || draft.trim() === ''} onPress={save}>
              Save note
            </Button>
          </View>
        </View>
      )}
      <ViewRun runId={note.runId} projectAi={projectAi} />
    </View>
  );
}

/**
 * The notes on a todo, and a box to add one.
 *
 * @param props.todoId The todo.
 * @param props.focusNoteId A note to mark and bring into view: the one an
 *   artifact link was opened from.
 */
export function TodoThread({ todoId, focusNoteId }: { todoId: string; focusNoteId?: string | null }) {
  const record = useTodoRecord(todoId);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const refetch = { refetchQueries: [{ query: TodoRecordDocument, variables: { id: todoId } }] };
  const [createNote, { loading: adding }] = useMutation(CreateTodoNoteDocument, refetch);
  const [editNote] = useMutation(EditTodoNoteDocument);
  const [deleteNote] = useMutation(DeleteTodoNoteDocument, refetch);

  const notes = record.data?.todo?.thread ?? [];
  const projectAi = record.data?.todo?.project?.aiEnabled === true;

  async function add() {
    const trimmed = body.trim();
    if (!trimmed) return;
    setError(null);
    try {
      await createNote({ variables: { todoId, body: trimmed } });
      setBody('');
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  async function edit(id: string, edited: string): Promise<boolean> {
    setError(null);
    try {
      await editNote({ variables: { id, body: edited } });
      return true;
    } catch (cause) {
      setError(describeError(cause));
      return false;
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await deleteNote({ variables: { id } });
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  return (
    <View className="gap-4">
      <LoadState
        query={record}
        what="the notes"
        count={notes.length}
        empty={<Text className="text-muted-foreground text-sm">No notes yet.</Text>}
      />
      {notes.length === 0 ? null : (
        <View role="list" className="gap-2">
          {notes.map((note) => (
            <ThreadNote
              key={note.id}
              note={note}
              focused={note.id === focusNoteId}
              projectAi={projectAi}
              onEdit={edit}
              onDelete={remove}
            />
          ))}
        </View>
      )}

      {error ? (
        <Text className="text-destructive text-sm" aria-live="polite">
          {error}
        </Text>
      ) : null}

      <View className="gap-2">
        <Textarea value={body} onChangeText={setBody} placeholder="Add a note…" rows={3} />
        <Button size="sm" className="self-end" disabled={adding || body.trim() === ''} onPress={add}>
          Add note
        </Button>
      </View>
    </View>
  );
}

type HistoryEvent = NonNullable<NonNullable<ReturnType<typeof useTodoRecord>['data']>['todo']>['history'][number];

/** The history and the runs, one timeline, oldest first. */
type Entry =
  | { at: string; event: HistoryEvent; run?: never }
  | { at: string; run: RunSummaryFieldsFragment; event?: never };

/**
 * What happened to a todo, in order. With `runs`, each time an agent worked
 * it is a line of its own among the moves it caused.
 */
export function TodoHistory({ todoId, runs = [] }: { todoId: string; runs?: readonly RunSummaryFieldsFragment[] }) {
  const record = useTodoRecord(todoId);
  const events = record.data?.todo?.history ?? [];
  const projectAi = record.data?.todo?.project?.aiEnabled === true;
  const entries: Entry[] = [
    ...events.map((event) => ({ at: event.at, event })),
    ...runs.map((run) => ({ at: run.startedAt, run })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const lanes = new Map((record.data?.todo?.project?.lanes ?? []).map((lane) => [lane.id, lane.name]));
  const laneName = (id: string | null | undefined) => (id ? (lanes.get(id) ?? 'a deleted lane') : 'no lane');

  function describe(event: HistoryEvent): string {
    switch (event.kind) {
      case 'create':
        return 'Created';
      case 'complete':
        return 'Completed';
      case 'reopen':
        return 'Reopened';
      case 'move':
        return `Moved from ${laneName(event.fromLaneId)} to ${laneName(event.toLaneId)}`;
      case 'retry':
        return `Sent round ${laneName(event.toLaneId)} again`;
      case 'run':
        return `Asked ${laneName(event.toLaneId)} to run it`;
      case 'archive':
        return 'Archived';
      case 'restore':
        return 'Restored';
      case 'edit':
        return event.fields.length > 0 ? `Changed ${event.fields.map(fieldName).join(', ')}` : 'Edited';
      default:
        return event.kind;
    }
  }

  return (
    <View className="gap-2">
      <LoadState
        query={record}
        what="the history"
        count={entries.length}
        empty={<Text className="text-muted-foreground text-sm">Nothing recorded yet.</Text>}
      />
      {entries.length === 0 ? null : (
        <View role="list" className="gap-2">
          {entries.map(({ event, run }) =>
            run ? (
              <View key={run.id} role="listitem" className="gap-0.5 border-primary/40 border-l-2 pl-3">
                <View className="flex-row items-center gap-2">
                  <Text className="text-foreground text-sm">
                    {run.agent?.name ?? 'A deleted agent'} worked it in {run.lane?.name ?? 'a deleted lane'}
                  </Text>
                  <RunStatusBadge status={run.status} />
                </View>
                {run.error ? <Text className="text-destructive text-sm">{run.error}</Text> : null}
                <Text className="text-muted-foreground text-xs">{describeRun(run)}</Text>
                <ViewRun runId={run.id} projectAi={projectAi} />
              </View>
            ) : (
              <View key={event.id} role="listitem" className="gap-0.5 border-border border-l-2 pl-3">
                <Text className="text-foreground text-sm">{describe(event)}</Text>
                {event.reason ? <Text className="text-muted-foreground text-sm">“{event.reason}”</Text> : null}
                <Text className="text-muted-foreground text-xs">
                  {actorName(event.actorKind)} · {formatTimestamp(event.at)}
                </Text>
                <ViewRun runId={event.runId} projectAi={projectAi} />
              </View>
            ),
          )}
        </View>
      )}
    </View>
  );
}

const FIELD_NAMES: Record<string, string> = {
  title: 'the title',
  notes: 'the notes',
  acceptance: 'the acceptance criteria',
  dueAt: 'the due date',
  parentId: 'the parent',
  aiIgnored: 'whether AI ignores it',
};

function fieldName(field: string): string {
  return FIELD_NAMES[field] ?? field;
}
