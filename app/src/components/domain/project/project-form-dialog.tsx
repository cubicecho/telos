import { useMutation } from '@apollo/client';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { FormDialog, FormDialogFooter } from '@/components/ui/form-dialog';
import { FormElement } from '@/components/ui/form-element';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { describeError } from '@/lib/errors';
import { CreateProjectDocument, ProjectDocument, ProjectsDocument, UpdateProjectDocument } from '@/lib/graphql';
import { newId } from '@/lib/ids';

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
  const [createProject, { loading: creating, error: createError }] = useMutation(CreateProjectDocument);
  const [updateProject, { loading: updating, error: updateError }] = useMutation(UpdateProjectDocument, {
    refetchQueries: [ProjectsDocument, ...(project ? [{ query: ProjectDocument, variables: { id: project.id } }] : [])],
  });

  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? '');
    setDescription(project?.description ?? '');
  }, [open, project]);

  const canSubmit = name.trim() !== '' && !creating && !updating;

  async function onSubmit() {
    const values = { name: name.trim(), description: description.trim() === '' ? null : description.trim() };
    if (!canSubmit) return;
    try {
      if (project) {
        await updateProject({ variables: { id: project.id, set: values } });
      } else {
        const id = newId();
        await createProject({
          variables: { values: { id, ...values } },
          optimisticResponse: {
            createProject: { __typename: 'Project', id, name: values.name, todoCount: 0, openTodoCount: 0 },
          },
          update(cache, { data }) {
            const created = data?.createProject;
            if (!created) return;
            cache.updateQuery({ query: ProjectsDocument }, (existing) =>
              existing
                ? {
                    ...existing,
                    // Re-sorted rather than appended: the sidebar query orders by
                    // name, so a project dropped at the end would jump the moment
                    // anything refetched.
                    projects: [...existing.projects.filter((row) => row.id !== created.id), created].sort((a, b) =>
                      a.name.localeCompare(b.name),
                    ),
                  }
                : existing,
            );
          },
        });
        // Navigated only once the row exists. The id is known up front, but the
        // project screen reads fields this mutation does not return, so arriving
        // early would mean a query for a row Postgres has not written yet.
        router.push(`/projects/${id}`);
      }
    } catch {
      // The mutation rejects as well as setting `error`, so an uncaught await
      // here is both an unhandled rejection and a dialog that stays open with
      // no explanation of why. Stay open — deliberately — but say so: what was
      // typed is still in the fields, ready to send again.
      return;
    }
    onOpenChange(false);
  }

  const error = createError ?? updateError;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={project ? 'Edit project' : 'New project'}
      description="A project is a list of todos. Nothing more, on purpose."
    >
      <FormElement onSubmit={onSubmit} className="gap-4">
        <Field>
          <FieldLabel htmlFor="project-name">Name</FieldLabel>
          <Input id="project-name" autoFocus value={name} placeholder="Kitchen renovation" onChangeText={setName} />
        </Field>
        <Field>
          <FieldLabel htmlFor="project-description">Description</FieldLabel>
          <Textarea
            id="project-description"
            value={description}
            placeholder="Optional."
            onChangeText={setDescription}
          />
        </Field>
        <FormDialogFooter onCancel={() => onOpenChange(false)} error={error ? describeError(error) : null}>
          {/* A Pressable raises no DOM submit, so it calls the handler itself;
              Enter in the name field still submits through `FormElement`. */}
          <Button disabled={!canSubmit} onPress={onSubmit}>
            {project ? 'Save' : 'Create'}
          </Button>
        </FormDialogFooter>
      </FormElement>
    </FormDialog>
  );
}
