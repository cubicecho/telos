import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { AgentFieldsFragment } from '@/__generated__/graphql';
import { ActionButton } from '@/components/action-button';
import { useAppForm } from '@/components/app-form';
import { ConfirmButton } from '@/components/confirm-button';
import { Section } from '@/components/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Form } from '@/components/ui/form';
import { FormDialog, FormDialogFooter } from '@/components/ui/form-dialog';
import { ChevronDown, Pencil, Plus, Trash2 } from '@/components/ui/icons';
import { LoadState } from '@/components/ui/load-failure';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import { AGENT_STARTERS, type AgentStarter, draftFromStarter } from '@/lib/agent-starters';
import { type AgentDraft, fromAgentDraft, layerHints, missingSetup, toAgentDraft } from '@/lib/agents';
import { describeError } from '@/lib/errors';
import {
  AgentDefaultsDocument,
  AgentsDocument,
  CreateAgentDocument,
  DeleteAgentDocument,
  SetAgentApiKeyDocument,
  UpdateAgentDocument,
} from '@/lib/graphql';
import { newId } from '@/lib/ids';
import {
  DISCOVERY_HELP,
  discoveryOptions,
  EFFORT_HELP,
  effortOptions,
  type NumberGroup,
  numbersIn,
} from './agent-settings-fields';
import {
  BASE_URL_HELP,
  type EndpointModel,
  EndpointStatus,
  FormGroupTitle,
  ModelField,
  useEndpointModels,
} from './endpoint-fields';
import { McpServerPicker } from './mcp-server-picker';
import { RunToolsPicker } from './run-tools-picker';

type AgentRow = AgentFieldsFragment;

/** What the form is open on: an agent, or a new one, blank or from a starter. */
type Editing = { agent: AgentRow } | { starter: AgentStarter | null };

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
  const [editing, setEditing] = useState<Editing | null>(null);
  const [keying, setKeying] = useState<AgentRow | null>(null);
  const [deleteAgent] = useMutation(DeleteAgentDocument, { refetchQueries: [AgentsDocument] });
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const agents = agentsQuery.data?.agents ?? [];

  async function confirmDelete(row: AgentRow) {
    setDeleteError(null);
    try {
      await deleteAgent({ variables: { id: row.id } });
    } catch (cause) {
      setDeleteError(describeError(cause));
    }
  }

  return (
    <Section
      surface="card"
      title="Agents"
      description="Models with instructions. Give a lane an agent and it works each todo that arrives there."
      action={
        <View className="flex-row gap-2">
          <Menu>
            <MenuTrigger asChild>
              <Button variant="outline" size="sm">
                Start from
                <ChevronDown className="h-4 w-4" />
              </Button>
            </MenuTrigger>
            <MenuContent align="end" aria-label="Agent starters">
              {AGENT_STARTERS.map((starter) => (
                <MenuItem key={starter.id} label={starter.name} onSelect={() => setEditing({ starter })} />
              ))}
            </MenuContent>
          </Menu>
          <Button size="sm" onPress={() => setEditing({ starter: null })}>
            <Plus className="h-4 w-4" />
            New agent
          </Button>
        </View>
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
                  <ActionButton
                    variant="ghost"
                    size="icon-sm"
                    label={`Edit ${agent.name}`}
                    onPress={() => setEditing({ agent })}
                  >
                    <Pencil className="h-4 w-4" />
                  </ActionButton>
                  <ConfirmButton
                    variant="ghost"
                    size="icon-sm"
                    className="hover:text-destructive"
                    label={`Delete ${agent.name}`}
                    title={`Delete “${agent.name}”?`}
                    description="Lanes it works stop being stations, and its runs lose their agent. This cannot be undone."
                    confirmLabel="Delete"
                    onConfirm={() => confirmDelete(agent)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </ConfirmButton>
                </View>
              ))}
            </View>
          )}

          {/* Keyed so switching from one agent to another starts a fresh form. */}
          {editing ? (
            <AgentFormDialog
              key={'agent' in editing ? editing.agent.id : `new-${editing.starter?.id ?? 'blank'}`}
              open
              onOpenChange={(open) => !open && setEditing(null)}
              agent={'agent' in editing ? editing.agent : null}
              starter={'starter' in editing ? editing.starter : null}
            />
          ) : null}

          {keying ? (
            <AgentKeyDialog key={keying.id} open onOpenChange={(open) => !open && setKeying(null)} agent={keying} />
          ) : null}
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

/** The form's values: the agent, and a key typed for it, which is saved on its own. */
type AgentFormValues = AgentDraft & { apiKey: string };

/**
 * Creating an agent or editing one, endpoint first: a base URL and a key,
 * the models it lists, then the rest. The key box is write-only, as the key
 * is: blank keeps what is stored, and clearing one is the key dialog's job,
 * so a blank box never has to mean both. A new agent can start from a
 * starter, which fills in all but the endpoint and the model.
 */
export function AgentFormDialog({
  open,
  onOpenChange,
  agent,
  starter = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: AgentRow | null;
  starter?: AgentStarter | null;
}) {
  const isEdit = agent !== null;
  const [createAgent, createState] = useMutation(CreateAgentDocument, { refetchQueries: [AgentsDocument] });
  const [updateAgent, updateState] = useMutation(UpdateAgentDocument);
  const [setKey, keyState] = useMutation(SetAgentApiKeyDocument, { refetchQueries: [AgentsDocument] });
  const error = createState.error ?? updateState.error ?? keyState.error;
  const inherited = useQuery(AgentDefaultsDocument).data?.agentDefaults.resolved;
  const hints = layerHints(inherited, 'defaults');
  const endpoint = useEndpointModels(agent?.id ?? null);
  const initial = useMemo<AgentFormValues>(
    () => ({ ...(agent ? toAgentDraft(agent) : draftFromStarter(starter)), apiKey: '' }),
    [agent, starter],
  );
  const form = useAppForm({
    defaultValues: initial,
    onSubmit: ({ value }) => save(value),
  });

  useEffect(() => {
    if (open) form.reset(initial);
  }, [open, initial, form]);

  /** The base URL a run would use: its own, else the default. */
  const effectiveBaseUrl = () => form.getFieldValue('baseUrl').trim() || inherited?.baseUrl || '';
  const askModels = (force = false) => endpoint.ask(effectiveBaseUrl(), form.getFieldValue('apiKey'), force);

  // With an endpoint already set, its own or the default, its models are listed
  // straight away, as min-agent lists the stored endpoint's.
  const defaultBaseUrl = inherited?.baseUrl;
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked once the default is known, not on every keystroke
  useEffect(() => {
    if (open) askModels();
  }, [open, defaultBaseUrl]);

  async function save({ apiKey, ...value }: AgentFormValues) {
    const values = fromAgentDraft(value);
    const id = agent?.id ?? newId();
    try {
      if (agent) await updateAgent({ variables: { id, set: values } });
      else await createAgent({ variables: { values: { id, ...values } } });
      if (apiKey.trim()) await setKey({ variables: { agentId: id, apiKey: apiKey.trim() } });
    } catch {
      // `error` says why, beside the buttons; what was typed stays.
      return;
    }
    onOpenChange(false);
  }

  const required = (what: string) => ({
    onChange: ({ value }: { value: string }) => (value.trim() === '' ? `An agent needs ${what}.` : undefined),
  });
  const numbers = (group: NumberGroup) => (
    <View className="flex-row flex-wrap gap-4">
      {numbersIn(group).map((spec) => (
        <View key={spec.name} className="min-w-[140px] flex-1">
          <form.AppField name={spec.name} validators={{ onChange: spec.rule }}>
            {(field) => (
              <field.InputField label={spec.label} inputMode={spec.inputMode} placeholder={hints[spec.name]} />
            )}
          </form.AppField>
        </View>
      ))}
    </View>
  );
  const pickModel = (model: EndpointModel) => {
    if (model.contextLength && !form.getFieldValue('contextLength').trim()) {
      form.setFieldValue('contextLength', String(model.contextLength));
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? `Edit ${agent.name}` : starter ? `New ${starter.name}` : 'New agent'}
      description={
        starter
          ? `${starter.description} Its prompt and settings are filled in: give it a base URL and a model, or leave them to your agent defaults.`
          : 'Any OpenAI-compatible endpoint: Ollama, llama.cpp, vLLM or a hosted API. A blank field inherits your agent defaults, shown greyed.'
      }
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

            <FormGroupTitle title="Endpoint" description="Where it runs. Its models are listed from here." />
            <form.AppField name="baseUrl" listeners={{ onBlur: () => askModels() }}>
              {(field) => <field.InputField label="Base URL" type="url" placeholder={hints.baseUrl} />}
            </form.AppField>
            <Text className="-mt-2 text-muted-foreground text-xs">{BASE_URL_HELP}</Text>
            <form.AppField name="apiKey" listeners={{ onBlur: () => askModels() }}>
              {(field) => (
                <field.PasswordField
                  label="API key"
                  placeholder={
                    agent?.hasApiKey
                      ? 'A key is set: leave blank to keep it'
                      : 'Optional. Local servers such as Ollama need none.'
                  }
                />
              )}
            </form.AppField>
            <form.Subscribe selector={(state) => state.values.baseUrl}>
              {(baseUrl) => (
                <EndpointStatus
                  endpoint={endpoint}
                  canLoad={Boolean(baseUrl.trim() || inherited?.baseUrl)}
                  onLoad={() => askModels(true)}
                />
              )}
            </form.Subscribe>

            <FormGroupTitle title="Model" />
            <form.AppField name="model">
              {() => (
                <ModelField
                  label="Model"
                  models={endpoint.models}
                  blankLabel={`Inherit (${hints.model || 'default'})`}
                  placeholder={hints.model}
                  onPick={pickModel}
                />
              )}
            </form.AppField>
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
            {numbers('model')}
            <form.AppField name="reasoningEffort">
              {(field) => (
                <field.SelectField
                  label="Reasoning effort"
                  options={effortOptions(hints.reasoningEffort, field.state.value)}
                />
              )}
            </form.AppField>
            <Text className="-mt-2 text-muted-foreground text-xs">{EFFORT_HELP}</Text>
            <form.AppField name="systemPrompt">
              {(field) => (
                <field.TextAreaField label="System prompt" placeholder="Optional. Who the agent is, in any lane." />
              )}
            </form.AppField>

            <FormGroupTitle title="Tools" />
            {numbers('tools')}
            <form.AppField name="toolDiscovery">
              {(field) => <field.SelectField label="Tool discovery" options={discoveryOptions(hints.toolDiscovery)} />}
            </form.AppField>
            <Text className="-mt-2 text-muted-foreground text-xs">{DISCOVERY_HELP}</Text>
            <form.AppField name="toolSelectModel">
              {() => (
                <ModelField
                  label="Tool selection model"
                  models={endpoint.models}
                  blankLabel={`Inherit (${hints.toolSelectModel || 'none'})`}
                  placeholder={hints.toolSelectModel}
                />
              )}
            </form.AppField>
            <form.AppField name="mcpServerSlugs">
              {(field) => <McpServerPicker slugs={field.state.value} onChange={(next) => field.handleChange(next)} />}
            </form.AppField>
            <form.AppField name="toolsOff">
              {(field) => <RunToolsPicker toolsOff={field.state.value} onChange={(next) => field.handleChange(next)} />}
            </form.AppField>

            <FormGroupTitle title="Requests" />
            {numbers('requests')}
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
            {(field) => <field.PasswordField label="API key" autoFocus />}
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
