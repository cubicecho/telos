import { useMutation } from '@apollo/client';
import { useRouter } from 'expo-router';
import { type FormEvent, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { CreateProjectDocument, ProjectDocument, ProjectsDocument, UpdateProjectDocument } from '@/lib/graphql';

export interface ProjectDraft {
  id: string;
  name: string;
  description: string | null;
}

export function ProjectFormDialog({
  open,
  onOpenChange,
  project,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project?: ProjectDraft;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [createProject, { loading: creating, error: createError }] = useMutation(CreateProjectDocument, {
    refetchQueries: [ProjectsDocument],
  });
  const [updateProject, { loading: updating, error: updateError }] = useMutation(UpdateProjectDocument, {
    refetchQueries: [ProjectsDocument, ...(project ? [{ query: ProjectDocument, variables: { id: project.id } }] : [])],
  });

  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? '');
    setDescription(project?.description ?? '');
  }, [open, project]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const values = { name: name.trim(), description: description.trim() === '' ? null : description.trim() };
    if (values.name === '') return;
    if (project) {
      await updateProject({ variables: { id: project.id, set: values } });
    } else {
      const { data } = await createProject({ variables: { values } });
      if (data?.createProject) router.push(`/projects/${data.createProject.id}`);
    }
    onOpenChange(false);
  }

  const error = createError ?? updateError;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{project ? 'Edit project' : 'New project'}</DialogTitle>
          <DialogDescription>A project is a list of todos. Nothing more, on purpose.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              autoFocus
              value={name}
              placeholder="Kitchen renovation"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="project-description">Description</Label>
            <Textarea
              id="project-description"
              value={description}
              placeholder="Optional."
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          {error ? <p className="text-destructive text-sm">{error.message}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={creating || updating || name.trim() === ''}>
              {project ? 'Save' : 'Create'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
