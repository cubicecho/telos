import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Text, View } from 'react-native';
import type { RunSummaryFieldsFragment } from '@/__generated__/graphql';
import { RunDialog } from '@/components/domain/ai/run-dialog';
import { describeRun, RunStatusBadge } from '@/components/domain/ai/run-log';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Trash2 } from '@/components/ui/icons';
import { LoadState } from '@/components/ui/load-failure';
import { Textarea } from '@/components/ui/textarea';
import { useAi } from '@/lib/ai';
import { formatTimestamp } from '@/lib/dates';
import { describeError } from '@/lib/errors';
import { CreateTodoNoteDocument, DeleteTodoNoteDocument, TodoRecordDocument } from '@/lib/graphql';

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
function ViewRun({ runId }: { runId: string | null | undefined }) {
  const ai = useAi();
  const [open, setOpen] = useState(false);
  if (!ai.on || !runId) return null;
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

export function TodoThread({ todoId }: { todoId: string }) {
  const record = useTodoRecord(todoId);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const refetch = { refetchQueries: [{ query: TodoRecordDocument, variables: { id: todoId } }] };
  const [createNote, { loading: adding }] = useMutation(CreateTodoNoteDocument, refetch);
  const [deleteNote] = useMutation(DeleteTodoNoteDocument, refetch);

  const notes = record.data?.todo?.thread ?? [];

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
            <View key={note.id} role="listitem" className="gap-1 rounded-lg border border-border px-3 py-2">
              <View className="flex-row items-center gap-2">
                <Text className="flex-1 text-muted-foreground text-xs">
                  {actorName(note.actorKind)} · {formatTimestamp(note.createdAt)}
                </Text>
                {note.kind === 'note' ? null : (
                  <Badge variant="secondary" className="self-center">
                    {note.kind}
                  </Badge>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="hover:text-destructive"
                  aria-label="Delete note"
                  onPress={() => remove(note.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </View>
              <Text className="text-foreground text-sm">{note.body}</Text>
              <ViewRun runId={note.runId} />
            </View>
          ))}
        </View>
      )}

      {error ? (
        <Text className="text-destructive text-sm" aria-live="polite">
          {error}
        </Text>
      ) : null}

      {/* Notes are never edited, only added and deleted: the thread is a
          record, and a note an agent acted on should still say what it said. */}
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
                <ViewRun runId={run.id} />
              </View>
            ) : (
              <View key={event.id} role="listitem" className="gap-0.5 border-border border-l-2 pl-3">
                <Text className="text-foreground text-sm">{describe(event)}</Text>
                {event.reason ? <Text className="text-muted-foreground text-sm">“{event.reason}”</Text> : null}
                <Text className="text-muted-foreground text-xs">
                  {actorName(event.actorKind)} · {formatTimestamp(event.at)}
                </Text>
                <ViewRun runId={event.runId} />
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
