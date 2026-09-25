import { useQuery } from '@apollo/client';
import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { ArtifactFieldsFragment } from '@/__generated__/graphql';
import { MessageSquare } from '@/components/app-icons';
import { Badge } from '@/components/ui/badge';
import { LoadState } from '@/components/ui/load-failure';
import { TodoRunsDocument } from '@/lib/graphql';
import { RUN_POLL_MS, RunRow } from './run-row';

// A todo's runs — each time a station's agent worked it — and the artifacts
// they left. Drawn only while AI is on for the account and the project; the
// todo dialog decides that, from the same query this reads.

export function useTodoRuns(todoId: string, { skip = false }: { skip?: boolean } = {}) {
  return useQuery(TodoRunsDocument, { variables: { id: todoId }, skip, fetchPolicy: 'cache-and-network' });
}

export function TodoRuns({
  todoId,
  pollMs = RUN_POLL_MS,
  onOpenNote,
}: {
  todoId: string;
  pollMs?: number;
  /** Opens the thread at a note an agent left, when an artifact is one. */
  onOpenNote?: (noteId: string) => void;
}) {
  const query = useTodoRuns(todoId);
  const runs = query.data?.todo?.runs ?? [];
  const artifacts = query.data?.todo?.artifacts ?? [];
  const live = runs.some((run) => run.status === 'running');
  const { startPolling, stopPolling } = query;

  // Asked again only while something is running: a finished run never changes,
  // and a todo nobody is working has nothing new to say.
  useEffect(() => {
    if (live) startPolling(pollMs);
    else stopPolling();
    return () => stopPolling();
  }, [live, pollMs, startPolling, stopPolling]);

  return (
    <View className="gap-6">
      <View className="gap-2">
        <LoadState
          query={query}
          what="the runs"
          count={runs.length}
          empty={<Text className="text-muted-foreground text-sm">No agent has worked this todo yet.</Text>}
        />
        {runs.length === 0 ? null : (
          <View role="list" aria-label="Runs" className="gap-2">
            {runs.map((run) => (
              <RunRow key={run.id} run={run} pollMs={pollMs} />
            ))}
          </View>
        )}
      </View>

      {artifacts.length === 0 ? null : (
        <View className="gap-2">
          <Text role="heading" aria-level={3} className="font-medium text-foreground text-sm">
            Artifacts
          </Text>
          <View role="list" aria-label="Artifacts" className="gap-1">
            {artifacts.map((artifact) => (
              <ArtifactRow key={artifact.id} artifact={artifact} onOpenNote={onOpenNote} />
            ))}
          </View>
        </View>
      )}
    </View>
  );
}

/** Where an artifact's location says it is a note on the todo: `telos:note/<id>`. */
const NOTE_LOCATION = 'telos:note/';

/**
 * The note an artifact is, if it is one.
 *
 * @param artifact The artifact.
 * @returns The note's id, or null for anything stored elsewhere.
 */
export function noteIdOf(artifact: Pick<ArtifactFieldsFragment, 'location'>): string | null {
  return artifact.location.startsWith(NOTE_LOCATION) ? artifact.location.slice(NOTE_LOCATION.length) || null : null;
}

export function ArtifactRow({
  artifact,
  todoTitle,
  onOpenNote,
}: {
  artifact: ArtifactFieldsFragment;
  todoTitle?: string;
  onOpenNote?: (noteId: string) => void;
}) {
  const noteId = noteIdOf(artifact);
  if (noteId) {
    // A note is already on the card, so it is a way into the thread rather
    // than a location nobody can open.
    const label = artifact.title || 'A note';
    const where = [todoTitle, 'Note on the card'].filter(Boolean).join(' · ');
    return (
      <View role="listitem">
        <Pressable
          role="link"
          aria-label={`${label}, ${where}`}
          disabled={!onOpenNote}
          onPress={() => onOpenNote?.(noteId)}
          className="flex-row items-center gap-2 rounded-lg border border-border px-3 py-2 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <MessageSquare className="h-4 w-4 text-muted-foreground" />
          <View className="min-w-0 flex-1 gap-0.5">
            <Text numberOfLines={1} className="text-foreground text-sm">
              {label}
            </Text>
            <Text numberOfLines={1} className="text-muted-foreground text-xs">
              {where}
            </Text>
          </View>
        </Pressable>
      </View>
    );
  }
  return (
    <View role="listitem" className="flex-row items-center gap-2 rounded-lg border border-border px-3 py-2">
      <View className="min-w-0 flex-1 gap-0.5">
        <Text numberOfLines={1} className="text-foreground text-sm">
          {artifact.title || artifact.location}
        </Text>
        <Text numberOfLines={1} className="text-muted-foreground text-xs">
          {[todoTitle, artifact.title ? artifact.location : null, artifact.mediaType].filter(Boolean).join(' · ')}
        </Text>
      </View>
      <Badge variant="outline">{artifact.action}</Badge>
      <Badge variant="secondary">{artifact.source}</Badge>
    </View>
  );
}
