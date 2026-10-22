import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { useAppForm } from '@/components/app-form';
import { Columns3 } from '@/components/app-icons';
import { EmptyState } from '@/components/empty-state';
import { Section } from '@/components/section';
import { Form } from '@/components/ui/form';
import { LoadState } from '@/components/ui/load-failure';
import { describeError } from '@/lib/errors';
import {
  GlobalContextDocument,
  ProjectContextsDocument,
  SetGlobalContextDocument,
  SetProjectContextDocument,
} from '@/lib/graphql';
import { CARD_TITLE } from '@/lib/styles';

// What every run is told beyond its agent's own instructions, as two layers of
// context: the account's, under every project, and each project's own. Both
// are a person's to edit here, and AI's to keep up to date through the MCP
// door, so most people read these more than they write them. The project
// prompt is the other thing a run is told, and is a person's alone: it is in
// the project's own form, not here.

/** Blank is nothing: the server stores it as null. */
function stored(text: string): string | null {
  return text.trim() === '' ? null : text.trim();
}

/** The Context tab: the account's global context, then each project's. */
export function ContextSettings() {
  return (
    <View className="gap-6">
      <GlobalContextForm />
      <ProjectContexts />
    </View>
  );
}

/** One context and its Save, with what came of the last save beside it. */
function ContextForm({
  label,
  description,
  value,
  placeholder,
  onSave,
}: {
  label: string;
  description?: string;
  value: string | null;
  placeholder: string;
  onSave: (context: string | null) => Promise<unknown>;
}) {
  const [failure, setFailure] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const initial = useMemo(() => ({ context: value ?? '' }), [value]);
  const form = useAppForm({
    defaultValues: initial,
    onSubmit: async ({ value: next }) => {
      setFailure(null);
      setSaved(false);
      try {
        await onSave(stored(next.context));
        setSaved(true);
      } catch (error) {
        // Said beside the button; what was typed stays.
        setFailure(error);
      }
    },
  });

  // A save, or an agent's write read back, replaces what the box started from.
  useEffect(() => {
    form.reset(initial);
  }, [initial, form]);

  return (
    <form.AppForm>
      <Form className="gap-3">
        <form.AppField name="context">
          {(field) => (
            <field.TextAreaField
              label={label}
              description={description}
              placeholder={placeholder}
              rows={3}
              maxRows={12}
            />
          )}
        </form.AppField>
        <View className="flex-row items-center justify-end gap-3">
          {failure ? (
            <Text className="flex-1 text-negative text-sm" aria-live="polite">
              {describeError(failure)}
            </Text>
          ) : saved ? (
            <Text className="flex-1 text-foreground/60 text-sm" aria-live="polite">
              Saved.
            </Text>
          ) : null}
          <form.SubmitButton isEdit editLabel="Save" requireChanges aria-label={`Save ${label}`} />
        </View>
      </Form>
    </form.AppForm>
  );
}

/** What every agent of the account is told, whichever project it works in. */
function GlobalContextForm() {
  const query = useQuery(GlobalContextDocument);
  const user = query.data?.users[0];
  const [setContext] = useMutation(SetGlobalContextDocument);

  return (
    <Section
      surface="card"
      titleClassName={CARD_TITLE}
      title="Global context"
      description="What every agent is told, whichever project it works in: who the work is for, the machines and tools at hand, conventions every project shares. Agents keep it up to date too, so it rarely needs editing."
      contentSlot={
        <View className="gap-4">
          <LoadState query={query} what="your global context" count={user ? 1 : 0} />
          {user ? (
            <ContextForm
              label="Global context"
              value={user.globalContext ?? null}
              placeholder="Nothing yet."
              onSave={(context) => setContext({ variables: { context } })}
            />
          ) : null}
        </View>
      }
    />
  );
}

/** Each open project's context, editable where it is listed. */
function ProjectContexts() {
  const query = useQuery(ProjectContextsDocument);
  const projects = query.data?.projects ?? [];
  const [setContext] = useMutation(SetProjectContextDocument);

  return (
    <Section
      surface="card"
      titleClassName={CARD_TITLE}
      title="Project context"
      description="What every agent working in a project is told about it, after the global context: the repo, its conventions, who the work is for. Agents keep these up to date too, so they rarely need editing."
      contentSlot={
        <View className="gap-6">
          <LoadState
            query={query}
            what="your projects"
            count={projects.length}
            emptySlot={
              <EmptyState
                iconSlot={<Columns3 />}
                title="No projects yet."
                description="A project's context is set here once there is one."
              />
            }
          />
          {projects.map((project) => (
            <ContextForm
              key={project.id}
              label={project.name}
              // It is still kept, for when the project is opened to agents.
              description={project.aiEnabled ? undefined : 'Closed to AI: no agent works here until you open it.'}
              value={project.context ?? null}
              placeholder="Nothing yet."
              onSave={(context) => setContext({ variables: { id: project.id, context } })}
            />
          ))}
        </View>
      }
    />
  );
}
