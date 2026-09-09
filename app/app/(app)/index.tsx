import { useQuery } from '@apollo/client';
import { Redirect } from 'expo-router';
import { useState } from 'react';
import { ProjectFormDialog } from '@/components/domain/project/project-form-dialog';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { ProjectsDocument } from '@/lib/graphql';

export default function HomeScreen() {
  const { data, loading } = useQuery(ProjectsDocument);
  const [creating, setCreating] = useState(false);

  if (loading && !data) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const first = data?.projects?.[0];
  if (first) return <Redirect href={`/projects/${first.id}`} />;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <div>
        <h1 className="font-semibold text-xl">Nothing here yet</h1>
        <p className="mt-1 text-muted-foreground text-sm">A project holds a list of todos. Start with one.</p>
      </div>
      <Button onClick={() => setCreating(true)}>Create a project</Button>
      <ProjectFormDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
