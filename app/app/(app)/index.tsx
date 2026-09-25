import { useQuery } from '@apollo/client';
import { Redirect } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { ProjectFormDialog } from '@/components/domain/project/project-form-dialog';
import { EmptyState } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons';
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
    <View className="flex-1 justify-center px-6">
      <EmptyState
        icon={Plus}
        title="Nothing here yet"
        description="A project holds a list of todos. Start with one."
        action={<Button onPress={() => setCreating(true)}>Create a project</Button>}
      />
      <ProjectFormDialog open={creating} onOpenChange={setCreating} />
    </View>
  );
}
