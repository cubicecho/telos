import { useLazyQuery, useMutation, useQuery } from '@apollo/client';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { AgentFieldsFragment } from '@/__generated__/graphql';
import { useAppForm } from '@/components/app-form';
import { Section } from '@/components/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Form } from '@/components/ui/form';
import { FormDialog, FormDialogFooter } from '@/components/ui/form-dialog';
import { ChevronDown, Pencil, Plus, Trash2 } from '@/components/ui/icons';
import { LoadState } from '@/components/ui/load-failure';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import { type AgentDraft, fromAgentDraft, layerHints, missingSetup, toAgentDraft } from '@/lib/agents';
import { describeError } from '@/lib/errors';
import {
  AgentDefaultsDocument,
  AgentModelsDocument,
  AgentsDocument,
  CreateAgentDocument,
  DeleteAgentDocument,
  SetAgentApiKeyDocument,
  UpdateAgentDocument,
} from '@/lib/graphql';
import { newId } from '@/lib/ids';
import { DISCOVERY_HELP, discoveryOptions, NUMBER_FIELDS } from './agent-settings-fields';
import { McpServerPicker } from './mcp-server-picker';

type AgentRow = AgentFieldsFragment;

/**
 * Agents: the models a lane can hand its todos to. Rendered only while AI is
 * on for the instance and the account — the schema has no agents otherwise.
 *
 * An agent does nothing on its own. It is named by a lane (a station), and the
 * runner works it there, so deleting one quietly turns its stations back into
 * ordinary lanes rather than failing. What it leaves blank it inherits from
 * the account's defaults (AgentDefaultsForm).
 */
export function AgentManager() {
  const agentsQuery = useQuery(AgentsDocument);
  const inherited = useQuery(AgentDefaultsDocument).data?.agentDefaults.resolved;
  const [editing, setEditing] = useState<AgentRow | 'new' | null>(null);
  const [keying, setKeying] = useState<AgentRow | null>(null);
  const [deleting, setDeleting] = useState<AgentRow | null>(null);
  const [deleteAgent] = useMutation(DeleteAgentDocument, { refetchQueries: [AgentsDocument] });
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const agents = agentsQuery.data?.agents ?? [];

  async function confirmDelete() {
    setDeleteError(null);
    try {
      if (deleting) await deleteAgent({ variables: { id: deleting.id } });
    } catch (cause) {
      setDeleteError(describeError(cause));
    }
    setDeleting(null);
  }

  return (
    <Section
      surface="card"
      title="Agents"
      description="Models a lane can hand its todos to. A lane with an agent is a station."
      action={
        <Button size="sm" onPress={() => setEditing('new')}>
          <Plus className="h-4 w-4" />
          New agent
        </Button>
      }
      content={
        <View className="gap-4">
          {deleteError ? (
            <Text className="text-destructive text-sm" aria-live="polite">
              {deleteError}
            </Text>
          ) : null}

          <LoadState
            query={agentsQuery}
            what="your agents"
            count={agents.length}
            empty={<Text className="text-muted-foreground text-sm">No agents yet.</Text>}
          />
          {agents.length === 0 ? null : (
            <View role="list" className="gap-1">
              {agents.map((agent) => (
                <View
                  key={agent.id}
                  role="listitem"
                  className="flex-row items-center gap-3 rounded-lg border border-border bg-card px-3 py-2"
                >
                  <View className="flex-1 gap-0.5">
                    <Text numberOfLines={1} className="text-foreground text-sm">
                      {agent.name}
                    </Text>
                    <Text numberOfLines={1} className="text-muted-foreground text-xs">
                      {agent.model ?? inheritedText(inherited?.model)} ·{' '}
                      {agent.baseUrl ?? inheritedText(inherited?.baseUrl)}
                    </Text>
                  </View>
                  {agent.enabled ? null : <Badge variant="outline">Off</Badge>}
                  <Badge variant={agent.hasApiKey ? 'secondary' : 'outline'}>
                    {agent.hasApiKey ? 'Key set' : 'No key'}
                  </Badge>
                  <Button variant="outline" size="sm" onPress={() => setKeying(agent)}>
                    {agent.hasApiKey ? 'Replace key' : 'Set key'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Edit ${agent.name}`}
                    onPress={() => setEditing(agent)}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="hover:text-destructive"
                    aria-label={`Delete ${agent.name}`}
                    onPress={() => setDeleting(agent)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </View>
              ))}
            </View>
          )}

          {/* Keyed so switching from one agent to another starts a fresh form. */}
          {editing ? (
            <AgentFormDialog
              key={editing === 'new' ? 'new' : editing.id}
              open
              onOpenChange={(open) => !open && setEditing(null)}
              agent={editing === 'new' ? null : editing}
            />
          ) : null}

          {keying ? (
            <AgentKeyDialog key={keying.id} open onOpenChange={(open) => !open && setKeying(null)} agent={keying} />
          ) : null}

          <ConfirmDialog
            open={deleting !== null}
            onOpenChange={(open) => !open && setDeleting(null)}
            title={`Delete “${deleting?.name ?? 'this agent'}”?`}
            description="Lanes it works stop being stations, and its runs lose their agent. This cannot be undone."
            confirmLabel="Delete"
            onConfirm={confirmDelete}
          />
        </View>
      }
    />
  );
}

/**
 * A blank field of an agent's, in its row: what it inherits.
 *
 * @param value - The default, empty when there is none, or undefined while it loads.
 * @returns The text.
 */
function inheritedText(value: string | undefined): string {
  if (value === undefined) return 'default';
  return value ? `${value} (default)` : 'none';
}

/**
 * Creating an agent or editing one. Everything but the API key, which is
 * write-only and has its own dialog, so an edit never has to say whether the
 * blank key box means "keep it" or "clear it".
 */
export function AgentFormDialog({
  open,
  onOpenChange,
  agent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: AgentRow | null;
}) {
  const isEdit = agent !== null;
  const [createAgent, createState] = useMutation(CreateAgentDocument, { refetchQueries: [AgentsDocument] });
  const [updateAgent, updateState] = useMutation(UpdateAgentDocument);
  const error = createState.error ?? updateState.error;
  const inherited = useQuery(AgentDefaultsDocument).data?.agentDefaults.resolved;
  const hints = layerHints(inherited, 'defaults');
  const initial = useMemo(() => toAgentDraft(agent), [agent]);
  const form = useAppForm({
    defaultValues: initial,
    onSubmit: ({ value }) => save(value),
  });

  useEffect(() => {
    if (open) form.reset(initial);
  }, [open, initial, form]);

  async function save(value: AgentDraft) {
    const values = fromAgentDraft(value);
    try {
      if (agent) await updateAgent({ variables: { id: agent.id, set: values } });
      else await createAgent({ variables: { values: { id: newId(), ...values } } });
    } catch {
      // `error` says why, beside the buttons; what was typed stays.
      return;
    }
    onOpenChange(false);
  }

  const required = (what: string) => ({
    onChange: ({ value }: { value: string }) => (value.trim() === '' ? `An agent needs ${what}.` : undefined),
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? `Edit ${agent.name}` : 'New agent'}
      description="Any OpenAI-compatible endpoint: Ollama, llama.cpp, vLLM or a hosted API. A blank field inherits your agent defaults, shown greyed."
      className="sm:max-w-[560px]"
    >
      <form.AppForm>
        <Form className="gap-4">
          {/* A scroll area clips what is drawn outside it, which a field's focus ring is: the
          padding is room for the ring, and the negative margin keeps the fields lined up
          with the dialog's title. */}
          <ScrollView className="-m-1 max-h-[60vh]" contentContainerClassName="gap-4 p-1">
            <form.AppField name="name" validators={required('a name')}>
              {(field) => <field.InputField label="Name" autoFocus placeholder="Reviewer" />}
            </form.AppField>
            <form.AppField name="enabled">
              {(field) => (
                <field.SwitchField
                  label="On"
                  description="Off, it takes no runs and no drafts, and its stations wait."
                />
              )}
            </form.AppField>
            <form.AppField name="baseUrl">
              {(field) => <field.InputField label="Base URL" type="url" placeholder={hints.baseUrl} />}
            </form.AppField>
            <View className="flex-row items-end gap-2">
              <View className="min-w-0 flex-1">
                <form.AppField name="model">
                  {(field) => <field.InputField label="Model" placeholder={hints.model} />}
                </form.AppField>
              </View>
              <ModelMenu
                agentId={agent?.id ?? null}
                baseUrl={() => form.getFieldValue('baseUrl').trim() || inherited?.baseUrl || ''}
                onPick={(model) => {
                  form.setFieldValue('model', model.id);
                  if (model.contextLength && !form.getFieldValue('contextLength').trim()) {
                    form.setFieldValue('contextLength', String(model.contextLength));
                  }
                }}
              />
            </View>
            <form.Subscribe selector={(state) => ({ baseUrl: state.values.baseUrl, model: state.values.model })}>
              {(own) => {
                const missing = missingSetup(own, inherited);
                return missing ? (
                  <Text className="text-destructive text-sm" aria-live="polite">
                    {missing}
                  </Text>
                ) : null;
              }}
            </form.Subscribe>
            <form.AppField name="systemPrompt">
              {(field) => (
                <field.TextAreaField label="System prompt" placeholder="Optional. Who the agent is, in any lane." />
              )}
            </form.AppField>
            {NUMBER_FIELDS.map((spec) => (
              <form.AppField key={spec.name} name={spec.name} validators={{ onChange: spec.rule }}>
                {(field) => (
                  <field.InputField label={spec.label} inputMode={spec.inputMode} placeholder={hints[spec.name]} />
                )}
              </form.AppField>
            ))}
            <form.AppField name="toolDiscovery">
              {(field) => <field.SelectField label="Tool discovery" options={discoveryOptions(hints.toolDiscovery)} />}
            </form.AppField>
            <Text className="-mt-2 text-muted-foreground text-xs">{DISCOVERY_HELP}</Text>
            <form.AppField name="toolSelectModel">
              {(field) => <field.InputField label="Tool selection model" placeholder={hints.toolSelectModel} />}
            </form.AppField>
            <form.AppField name="mcpServerSlugs">
              {(field) => <McpServerPicker slugs={field.state.value} onChange={(next) => field.handleChange(next)} />}
            </form.AppField>
          </ScrollView>
          <FormDialogFooter onCancel={() => onOpenChange(false)} error={error ? describeError(error) : null}>
            <form.SubmitButton isEdit={isEdit} createLabel="Create agent" editLabel="Save" />
          </FormDialogFooter>
        </Form>
      </form.AppForm>
    </FormDialog>
  );
}

/**
 * The models the base URL offers, asked for when the menu opens: the server
 * reads the endpoint's `/models`, with the key a run would send there.
 * Typing a model in is always still there, for an endpoint that lists nothing.
 */
function ModelMenu({
  agentId,
  baseUrl,
  onPick,
}: {
  agentId: string | null;
  baseUrl: () => string;
  onPick: (model: { id: string; contextLength?: number | null }) => void;
}) {
  const [load, query] = useLazyQuery(AgentModelsDocument, { fetchPolicy: 'network-only' });
  const models = query.data?.agentModels ?? [];

  function opened(open: boolean) {
    const url = baseUrl().trim();
    if (open && url) void load({ variables: { baseUrl: url, agentId } }).catch(() => undefined);
  }

  let status: string | null = null;
  if (!query.called) status = 'Give a base URL first.';
  else if (query.loading) status = 'Asking the endpoint…';
  else if (query.error) status = describeError(query.error);
  else if (models.length === 0) status = 'It lists no models.';

  return (
    <Menu onOpenChange={opened}>
      <MenuTrigger asChild>
        <Button variant="outline" aria-label="Pick from the endpoint’s models">
          Models
          <ChevronDown className="h-4 w-4" />
        </Button>
      </MenuTrigger>
      <MenuContent align="end" aria-label="Models" className="max-h-80 overflow-y-auto">
        {status ? <MenuItem label={status} disabled /> : null}
        {models.map((model) => (
          <MenuItem
            key={model.id}
            label={model.id}
            trailing={model.contextLength ? `${model.contextLength.toLocaleString()} ctx` : undefined}
            onSelect={() => onPick(model)}
          />
        ))}
      </MenuContent>
    </Menu>
  );
}

/**
 * Setting, replacing or clearing an agent's API key. The key is never read
 * back — not here, not anywhere but the runner's claim — so the dialog can only
 * say whether one is stored.
 */
function AgentKeyDialog({
  open,
  onOpenChange,
  agent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: AgentRow;
}) {
  const [setKey, { error, loading }] = useMutation(SetAgentApiKeyDocument);
  const form = useAppForm({
    defaultValues: { apiKey: '' },
    onSubmit: ({ value }) => save(value.apiKey.trim()),
  });

  async function save(apiKey: string | null) {
    try {
      await setKey({ variables: { agentId: agent.id, apiKey } });
    } catch {
      return;
    }
    onOpenChange(false);
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`API key for ${agent.name}`}
      description={
        agent.hasApiKey
          ? 'A key is set. A new one replaces it; it cannot be shown.'
          : 'No key is set. Local servers such as Ollama need none.'
      }
    >
      <form.AppForm>
        <Form className="gap-4">
          <form.AppField
            name="apiKey"
            validators={{ onChange: ({ value }) => (value.trim() === '' ? 'Paste a key, or cancel.' : undefined) }}
          >
            {(field) => <field.InputField label="API key" type="password" autoFocus />}
          </form.AppField>
          <FormDialogFooter
            onCancel={() => onOpenChange(false)}
            error={error ? describeError(error) : null}
            secondary={
              agent.hasApiKey ? (
                <Button variant="ghost" className="text-destructive" disabled={loading} onPress={() => save(null)}>
                  Clear key
                </Button>
              ) : null
            }
          >
            <form.SubmitButton createLabel={agent.hasApiKey ? 'Replace key' : 'Set key'} disabled={loading} />
          </FormDialogFooter>
        </Form>
      </form.AppForm>
    </FormDialog>
  );
}
