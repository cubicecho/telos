import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import type { PromptFieldsFragment } from '@/__generated__/graphql';
import { useAppForm } from '@/components/app-form';
import { ConfirmButton } from '@/components/confirm-button';
import { DialogLayout } from '@/components/dialog-layout';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { Section } from '@/components/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Form } from '@/components/ui/form';
import { FileText, Pencil, Plus, Trash2 } from '@/components/ui/icons';
import { LoadState } from '@/components/ui/load-failure';
import { describeError } from '@/lib/errors';
import {
  AgentInstructionsDocument,
  AgentsDocument,
  CreatePromptDocument,
  DeletePromptDocument,
  PromptsDocument,
  SetAgentInstructionsDocument,
  UpdatePromptDocument,
} from '@/lib/graphql';
import { newId } from '@/lib/ids';
import { CARD_TITLE } from '@/lib/styles';

// What a run is told, apart from the todo itself, is four layers: the
// account's agent instructions, the project's description, the project's
// prompt, and the agent's own prompt. The project's two are in the project's
// form; the other two are here. Both are a person's alone: AI can read what it
// is told, never write it.

type PromptRow = PromptFieldsFragment;

/**
 * What a box of instructions stores: blank, or the default as it stands, is
 * null, so the account follows the default, and a later change to it, rather
 * than a copy frozen on the day it was saved.
 *
 * @param text - What was typed.
 * @param fallback - The built-in default.
 * @returns The text to store, or null for the default.
 */
export function storedInstructions(text: string, fallback: string): string | null {
  const trimmed = text.trim();
  return trimmed === '' || trimmed === fallback.trim() ? null : trimmed;
}

/** The Prompts tab: what every agent is told first, then the account's prompts. */
export function PromptSettings() {
  return (
    <View className="gap-6">
      <AgentInstructionsForm />
      <PromptManager />
    </View>
  );
}

/**
 * The account's agent instructions: sent to every agent first, before its
 * project's and its own prompt. Null is the built-in default, shown in the
 * box, so there is always something to read and edit from; Reset goes back
 * to it.
 */
export function AgentInstructionsForm() {
  const query = useQuery(AgentInstructionsDocument);
  const user = query.data?.users[0];
  const fallback = query.data?.defaultAgentInstructions ?? '';
  const own = user?.agentInstructions ?? null;
  const [setInstructions, { loading: resetting }] = useMutation(SetAgentInstructionsDocument);
  const [failure, setFailure] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const initial = useMemo(() => ({ instructions: own ?? fallback }), [own, fallback]);
  const form = useAppForm({
    defaultValues: initial,
    onSubmit: async ({ value }) => save(storedInstructions(value.instructions, fallback)),
  });

  // A save, or a reset, replaces what the box started from.
  useEffect(() => {
    form.reset(initial);
  }, [initial, form]);

  async function save(instructions: string | null) {
    setFailure(null);
    setSaved(false);
    try {
      await setInstructions({ variables: { instructions } });
      setSaved(true);
    } catch (error) {
      // Said beside the buttons; what was typed stays.
      setFailure(error);
    }
  }

  return (
    <Section
      surface="card"
      titleClassName={CARD_TITLE}
      title="Agent instructions"
      description="Sent to every agent first, before anything else it is told: then the project’s description and prompt, then the agent’s own prompt. Clear it, or reset it, to go back to the default."
      contentSlot={
        <View className="gap-4">
          <LoadState query={query} what="your agent instructions" count={user ? 1 : 0} />
          {user ? (
            <form.AppForm>
              <Form className="gap-3">
                <form.AppField name="instructions">
                  {(field) => (
                    <field.TextAreaField
                      label="Agent instructions"
                      description={own === null ? 'The default.' : 'Your own, in place of the default.'}
                      rows={6}
                      maxRows={20}
                    />
                  )}
                </form.AppField>
                <View className="flex-row flex-wrap items-center justify-end gap-3">
                  {failure ? (
                    <Text className="flex-1 text-negative text-sm" aria-live="polite">
                      {describeError(failure)}
                    </Text>
                  ) : saved ? (
                    <Text className="flex-1 text-foreground/60 text-sm" aria-live="polite">
                      Saved.
                    </Text>
                  ) : null}
                  <ConfirmButton
                    variant="outline"
                    size="sm"
                    disabled={own === null || resetting}
                    hint={own === null ? 'Already the default' : undefined}
                    title="Reset to the default?"
                    description="Your own agent instructions are replaced by the default. This cannot be undone."
                    confirmLabel="Reset"
                    onConfirm={() => save(null)}
                    content="Reset to default"
                  />
                  <form.SubmitButton isEdit editLabel="Save" requireChanges aria-label="Save agent instructions" />
                </View>
              </Form>
            </form.AppForm>
          ) : null}
        </View>
      }
    />
  );
}

/**
 * How many of the account's agents use a prompt.
 *
 * @param promptId - The prompt.
 * @param agents - The account's agents, empty while they load.
 * @returns The count.
 */
function usersOf(promptId: string, agents: readonly { promptId: string | null }[]): number {
  return agents.filter((agent) => agent.promptId === promptId).length;
}

/**
 * What deleting a prompt does, said before it is done.
 *
 * @param uses - How many agents use it.
 * @returns The sentence.
 */
export function deletePromptText(uses: number): string {
  if (uses === 0) return 'No agent uses it. This cannot be undone.';
  const agents = uses === 1 ? '1 agent uses it and is' : `${uses} agents use it and are`;
  return `${agents} left with no prompt, told only your agent instructions and the project’s. This cannot be undone.`;
}

/**
 * The account's prompts: what an agent is told about its job. Every account
 * starts with a Planner, a Reviewer and a Worker, and they are edited and
 * deleted like any other.
 */
export function PromptManager() {
  const query = useQuery(PromptsDocument);
  const agents = useQuery(AgentsDocument).data?.agents ?? [];
  const [editing, setEditing] = useState<{ prompt: PromptRow | null } | null>(null);
  // Its agents lose it, so they are read again.
  const [deletePrompt] = useMutation(DeletePromptDocument, { refetchQueries: [PromptsDocument, AgentsDocument] });
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const prompts = query.data?.prompts ?? [];

  async function confirmDelete(prompt: PromptRow) {
    setDeleteError(null);
    try {
      await deletePrompt({ variables: { id: prompt.id } });
    } catch (cause) {
      setDeleteError(describeError(cause));
    }
  }

  return (
    <Section
      surface="card"
      titleClassName={CARD_TITLE}
      title="Prompts"
      description="What an agent is told about its job. Each agent picks one; edit one here and every agent using it is told the new text from its next run."
      actionSlot={
        <Button
          variant="positive"
          size="sm"
          onPress={() => setEditing({ prompt: null })}
          iconSlot={<Plus className="h-4 w-4" />}
          content="New prompt"
        />
      }
      contentSlot={
        <View className="gap-4">
          {deleteError ? (
            <Text className="text-negative text-sm" aria-live="polite">
              {deleteError}
            </Text>
          ) : null}
          <LoadState
            query={query}
            what="your prompts"
            count={prompts.length}
            emptySlot={
              <EmptyState
                iconSlot={<FileText />}
                title="No prompts."
                description="A prompt says what an agent’s job is. Write one, then pick it for an agent."
              />
            }
          />
          <List
            divided={false}
            contentSlot={prompts.map((prompt) => {
              const uses = usersOf(prompt.id, agents);
              return (
                <View
                  key={prompt.id}
                  className="flex-row items-center gap-3 rounded-lg border border-foreground/10 bg-secondary px-3 py-2"
                >
                  <View className="flex-1 gap-0.5">
                    <Text numberOfLines={1} className="text-foreground text-sm">
                      {prompt.name}
                    </Text>
                    <Text numberOfLines={1} className="text-foreground/60 text-xs">
                      {prompt.body.trim().split('\n')[0] || 'Empty'}
                    </Text>
                  </View>
                  <Badge variant={uses ? 'secondary' : 'outline'}>{uses === 1 ? '1 agent' : `${uses} agents`}</Badge>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Edit ${prompt.name}`}
                    onPress={() => setEditing({ prompt })}
                    iconSlot={<Pencil className="h-4 w-4" />}
                  />
                  <ConfirmButton
                    variant="ghost"
                    size="icon-sm"
                    className="hover:text-negative"
                    aria-label={`Delete ${prompt.name}`}
                    title={`Delete “${prompt.name}”?`}
                    description={deletePromptText(uses)}
                    confirmLabel="Delete"
                    onConfirm={() => confirmDelete(prompt)}
                    iconSlot={<Trash2 className="h-4 w-4" />}
                  />
                </View>
              );
            })}
          />
          {/* Keyed so switching from one prompt to another starts a fresh form. */}
          {editing ? (
            <PromptFormDialog
              key={editing.prompt?.id ?? 'new'}
              open
              onOpenChange={(open) => !open && setEditing(null)}
              prompt={editing.prompt}
              taken={prompts.filter((other) => other.id !== editing.prompt?.id).map((other) => other.name)}
            />
          ) : null}
        </View>
      }
    />
  );
}

/**
 * Writing a prompt, or rewriting one. A name is unique in the account, so the
 * agent form's list never shows two of one name.
 */
export function PromptFormDialog({
  open,
  onOpenChange,
  prompt,
  taken,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prompt: PromptRow | null;
  /** The names the account's other prompts have. */
  taken: readonly string[];
}) {
  const isEdit = prompt !== null;
  const [createPrompt, createState] = useMutation(CreatePromptDocument, { refetchQueries: [PromptsDocument] });
  const [updatePrompt, updateState] = useMutation(UpdatePromptDocument);
  const error = createState.error ?? updateState.error;
  const form = useAppForm({
    defaultValues: { name: prompt?.name ?? '', body: prompt?.body ?? '' },
    onSubmit: ({ value }) => save({ name: value.name.trim(), body: value.body.trim() }),
  });

  async function save(values: { name: string; body: string }) {
    try {
      if (prompt) await updatePrompt({ variables: { id: prompt.id, set: values } });
      else await createPrompt({ variables: { values: { id: newId(), ...values } } });
    } catch {
      // `error` says why, beside the buttons; what was typed stays.
      return;
    }
    onOpenChange(false);
  }

  const lowerTaken = taken.map((name) => name.toLowerCase());
  return (
    <form.AppForm>
      <DialogLayout
        open={open}
        onOpenChange={onOpenChange}
        title={isEdit ? `Edit ${prompt.name}` : 'New prompt'}
        description="What an agent using it is told about its job: who it is, what it does with a todo, and how its reply should end."
        size="lg"
        hasUnsavedChanges={() => !form.state.isDefaultValue}
        footerSlot={
          error ? (
            <Text role="alert" className="text-negative text-sm">
              {describeError(error)}
            </Text>
          ) : null
        }
        footerActionsSlot={(close) => (
          <>
            <Button variant="outline" onPress={close} content="Cancel" />
            <form.SubmitButton isEdit={isEdit} createLabel="Create prompt" editLabel="Save" requireChanges={isEdit} />
          </>
        )}
        contentSlot={
          <Form className="gap-4">
            <form.AppField
              name="name"
              validators={{
                onChange: ({ value }) => {
                  const name = value.trim();
                  if (!name) return 'A prompt needs a name.';
                  return lowerTaken.includes(name.toLowerCase()) ? 'Another prompt has that name.' : undefined;
                },
              }}
            >
              {(field) => <field.InputField label="Name" autoFocus placeholder="Reviewer" />}
            </form.AppField>
            <form.AppField
              name="body"
              validators={{ onChange: ({ value }) => (value.trim() ? undefined : 'A prompt needs some text.') }}
            >
              {(field) => <field.TextAreaField label="Prompt" rows={12} maxRows={30} />}
            </form.AppField>
          </Form>
        }
      />
    </form.AppForm>
  );
}
