import { useMutation } from '@apollo/client';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Button } from '@/components/ui/button';
import { describeError } from '@/lib/errors';
import { RunTodoDocument } from '@/lib/graphql';

/** The queries an asked-for run changes the answer to. */
const REFRESHED: ReadonlySet<string> = new Set(['ProjectActivity', 'TodoRuns']);

/**
 * Asks for a todo to be worked now, where it stands. The server decides
 * whether an agent would take it and says why not in words meant for the
 * person, so those are shown as they come. Drawn only while AI is on for the
 * account and the project; the todo dialog decides that.
 */
export function RunTodoButton({ todoId, title }: { todoId: string; title: string }) {
  // By name among the active ones: the dialog also opens where no page polls
  // the project's activity, and naming a query nobody holds is an error.
  const [runTodo, { loading }] = useMutation(RunTodoDocument, {
    refetchQueries: 'active',
    onQueryUpdated: (query) => query.queryName !== undefined && REFRESHED.has(query.queryName),
  });
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);

  async function ask() {
    setError(null);
    setAsked(false);
    try {
      await runTodo({ variables: { id: todoId } });
      setAsked(true);
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  return (
    <View className="gap-1">
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={loading}
        aria-label={`Run “${title}” now`}
        onPress={ask}
      >
        Run now
      </Button>
      {error ? (
        <Text className="text-destructive text-xs" aria-live="polite">
          {error}
        </Text>
      ) : null}
      {asked ? (
        <Text className="text-muted-foreground text-xs" aria-live="polite">
          Asked. An agent takes it when its lane has room.
        </Text>
      ) : null}
    </View>
  );
}
