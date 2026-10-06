import { useQuery } from '@apollo/client';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { EmptyState } from '@/components/page';
import { PageLayout } from '@/components/page-layout';
import { Button } from '@/components/ui/button';
import { CircleAlert } from '@/components/ui/icons';
import { LoadFailure } from '@/components/ui/load-failure';
import { TodoLinkDocument } from '@/lib/graphql';

/**
 * A todo's own link, the one `Todo.url` hands to other apps. It names the todo
 * and not its project, so it survives the todo moving; all this screen does is
 * find the project and go there with the todo open. An archived todo lands on
 * the project's Archived view instead, where it can be restored.
 */
export default function TodoLinkScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, loading, error, refetch } = useQuery(TodoLinkDocument, {
    variables: { id: id as string },
    skip: !id,
  });

  if (loading && !data) {
    return <PageLayout loading title={undefined} contentSlot={null} />;
  }

  // As on the project screen: with the API unreachable, saying the todo is
  // gone would be a claim the app cannot make.
  if (error && !data) {
    return (
      <View className="flex-1 items-center justify-center px-6">
        <LoadFailure error={error} onRetry={refetch} what="this todo" />
      </View>
    );
  }

  const todo = data?.todos[0];
  if (!todo) {
    return (
      <View className="flex-1 justify-center px-6">
        <EmptyState
          icon={CircleAlert}
          title="Todo not found"
          description="That todo doesn't exist, or isn't yours."
          actionSlot={
            <Button variant="outline" size="sm" onPress={() => router.replace('/')} content="Go to your projects" />
          }
        />
      </View>
    );
  }

  return (
    <Redirect
      href={{
        pathname: '/projects/[id]',
        params: todo.archivedAt ? { id: todo.projectId, view: 'archived' } : { id: todo.projectId, todo: todo.id },
      }}
    />
  );
}
