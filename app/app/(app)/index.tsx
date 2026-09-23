import { useQuery } from '@apollo/client';
import { Redirect } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { ProjectFormDialog } from '@/components/domain/project/project-form-dialog';
import { Button } from '@/components/ui/button';
import { LoadFailure } from '@/components/ui/load-failure';
import { Spinner } from '@/components/ui/spinner';
import { ProjectsDocument } from '@/lib/graphql';

export default function HomeScreen() {
  const { data, loading, error, refetch } = useQuery(ProjectsDocument);
  const [creating, setCreating] = useState(false);

  if (loading && !data) {
    return (
      <View className="flex-1 items-center justify-center">
        <Spinner />
      </View>
    );
  }

  // Before the empty state, because this screen's job is to pick a project to
  // redirect to: with the list unfetched it cannot know there is none to pick,
  // and inviting someone to create their first project when they have twelve
  // is the worst version of getting this wrong.
  if (error && !data) {
    return (
      <View className="flex-1 items-center justify-center px-6">
        <LoadFailure error={error} onRetry={refetch} what="your projects" />
      </View>
    );
  }

  const first = data?.projects?.[0];
  if (first) return <Redirect href={`/projects/${first.id}`} />;

  return (
    <View className="flex-1 items-center justify-center gap-4 px-6">
      <View className="items-center">
        <Text role="heading" aria-level={1} className="font-semibold text-foreground text-xl">
          Nothing here yet
        </Text>
        <Text className="mt-1 text-center text-muted-foreground text-sm">
          A project holds a list of todos. Start with one.
        </Text>
      </View>
      <Button onPress={() => setCreating(true)}>Create a project</Button>
      <ProjectFormDialog open={creating} onOpenChange={setCreating} />
    </View>
  );
}
