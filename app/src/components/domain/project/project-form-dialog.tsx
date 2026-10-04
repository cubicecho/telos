import { useMutation, useQuery } from '@apollo/client';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Text, View } from 'react-native';
import { useAppForm } from '@/components/app-form';
import { Form } from '@/components/ui/form';
import { FormDialog, FormDialogFooter } from '@/components/ui/form-dialog';
import { describeError } from '@/lib/errors';
import {
  ApplyBoardTemplateDocument,
  BoardTemplatesDocument,
  CreateProjectDocument,
  ProjectDocument,
  ProjectLanesDocument,
  ProjectsDocument,
  UpdateProjectDocument,
} from '@/lib/graphql';
import { newId } from '@/lib/ids';

/** The "Start from" choice for the lanes every new project is given. */
const DEFAULT_LANES = 'default';

/** "The first open lane" as the place new todos land: a select refuses an empty value. */
const FIRST_OPEN_LANE = 'first';

export interface ProjectDraft {
  id: string;
  name: string;
  description: string | null;
  /** The lane new todos land in, or null for the first open lane. */
  newTodoLaneId: string | null;
}

interface ProjectFormValues {
  name: string;
  description: string;
  template: string;
  /** A lane's id, or `FIRST_OPEN_LANE`. */
  newTodoLane: string;
}

/**
 * What the form starts with: the project's own values, or blanks for a new one.
 *
 * @param project - The project being edited, or undefined for a new one.
 * @returns The form's values.
 */
function toValues(project: ProjectDraft | undefined): ProjectFormValues {
  return {
    name: project?.name ?? '',
    description: project?.description ?? '',
    template: DEFAULT_LANES,
    newTodoLane: project?.newTodoLaneId ?? FIRST_OPEN_LANE,
  };
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
  const [createProject, { loading: creating, error: createError }] = useMutation(CreateProjectDocument);
  const [updateProject, { loading: updating, error: updateError }] = useMutation(UpdateProjectDocument, {
    refetchQueries: [ProjectsDocument, ...(project ? [{ query: ProjectDocument, variables: { id: project.id } }] : [])],
  });

  // Only a new project starts from a template: applying one replaces a board.
  const templatesQuery = useQuery(BoardTemplatesDocument, { skip: !open || project !== undefined });
  const templates = templatesQuery.data?.boardTemplates ?? [];
  const [applyTemplate] = useMutation(ApplyBoardTemplateDocument);

  // Only a project that exists has lanes for its new todos to land in.
  const lanesQuery = useQuery(ProjectLanesDocument, {
    variables: { projectId: project?.id ?? '' },
    skip: !open || project === undefined,
  });
  const openLanes = (lanesQuery.data?.lanes ?? []).filter((lane) => lane.isDone === false);

  const form = useAppForm({
    defaultValues: toValues(undefined),
    onSubmit: ({ value }) => save(value),
  });

  // Reset from the project each time it opens, not on mount: the dialog
  // outlives a cancel, so a reopened form must show what is stored rather than
  // what was last typed and abandoned.
  useEffect(() => {
    if (!open) return;
    form.reset(toValues(project));
  }, [open, project, form]);

  async function save({ name, description, template, newTodoLane }: ProjectFormValues) {
    const values = { name: name.trim(), description: description.trim() === '' ? null : description.trim() };
    if (creating || updating) return;
    try {
      if (project) {
        const newTodoLaneId = newTodoLane === FIRST_OPEN_LANE ? null : newTodoLane;
        await updateProject({ variables: { id: project.id, set: { ...values, newTodoLaneId } } });
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
        if (template !== DEFAULT_LANES) {
          // The project exists by now, with the default lanes, so a template
          // that fails to apply leaves it usable rather than half made: go to
          // it anyway, rather than keep a dialog whose resend would make a
          // second project.
          await applyTemplate({ variables: { projectId: id, templateId: template } }).catch(() => undefined);
        }
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
      <form.AppForm>
        <Form className="gap-4">
          <form.AppField
            name="name"
            validators={{ onChange: ({ value }) => (value.trim() === '' ? 'Give the project a name.' : undefined) }}
          >
            {(field) => <field.InputField label="Name" autoFocus placeholder="Kitchen renovation" />}
          </form.AppField>
          <form.AppField name="description">
            {(field) => <field.TextAreaField label="Description" placeholder="Optional." />}
          </form.AppField>
          {project === undefined && templates.length > 0 ? (
            <form.AppField name="template">
              {(field) => (
                <field.SelectField
                  label="Start from"
                  options={[
                    { label: 'The usual lanes', value: DEFAULT_LANES },
                    ...templates.map((row) => ({ label: row.name, value: row.id })),
                  ]}
                />
              )}
            </form.AppField>
          ) : null}
          {project !== undefined && openLanes.length > 0 ? (
            <View className="gap-1">
              <form.AppField name="newTodoLane">
                {(field) => (
                  <field.SelectField
                    label="New todos land in"
                    options={[
                      { label: 'The first open lane', value: FIRST_OPEN_LANE },
                      ...openLanes.map((lane) => ({ label: lane.name, value: lane.id })),
                    ]}
                  />
                )}
              </form.AppField>
              <Text className="text-muted-foreground text-xs">
                A request, a finished draft, and the todos an agent splits one into.
              </Text>
            </View>
          ) : null}
          <FormDialogFooter onCancel={() => onOpenChange(false)} error={error ? describeError(error) : null}>
            <form.SubmitButton isEdit={project !== undefined} editLabel="Save" />
          </FormDialogFooter>
        </Form>
      </form.AppForm>
    </FormDialog>
  );
}
