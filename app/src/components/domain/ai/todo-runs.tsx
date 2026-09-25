import { useQuery } from '@apollo/client';
import { useEffect } from 'react';
import { Text, View } from 'react-native';
import type { ArtifactFieldsFragment } from '@/__generated__/graphql';
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

export function TodoRuns({ todoId, pollMs = RUN_POLL_MS }: { todoId: string; pollMs?: number }) {
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
              <ArtifactRow key={artifact.id} artifact={artifact} />
            ))}
          </View>
        </View>
      )}
    </View>
  );
}

export function ArtifactRow({ artifact, todoTitle }: { artifact: ArtifactFieldsFragment; todoTitle?: string }) {
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
