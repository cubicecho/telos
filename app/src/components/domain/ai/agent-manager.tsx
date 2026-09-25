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
import { ChevronDown, Pencil, Plus, Trash2, X } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { LoadState } from '@/components/ui/load-failure';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import { Textarea } from '@/components/ui/textarea';
import {
  type AgentDraft,
  emptyMcpServer,
  fromAgentDraft,
  type McpServerDraft,
  numberRule,
  toAgentDraft,
  toStoredServer,
} from '@/lib/agents';
import { describeError } from '@/lib/errors';
import {
  AgentModelsDocument,
  AgentsDocument,
  CreateAgentDocument,
  DeleteAgentDocument,
  McpProbeDocument,
  SetAgentApiKeyDocument,
  TestMcpServerDocument,
  UpdateAgentDocument,
} from '@/lib/graphql';
import { newId } from '@/lib/ids';

type AgentRow = AgentFieldsFragment;

/**
 * Agents: the models a lane can hand its todos to. Rendered only while AI is
 * on for the instance and the account — the schema has no agents otherwise.
 *
 * An agent does nothing on its own. It is named by a lane (a station), and the
 * runner works it there, so deleting one quietly turns its stations back into
 * ordinary lanes rather than failing.
 */
export function AgentManager() {
  const agentsQuery = useQuery(AgentsDocument);
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
                      {agent.model} · {agent.baseUrl}
                    </Text>
                  </View>
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
      description="Any OpenAI-compatible endpoint: Ollama, llama.cpp, vLLM or a hosted API."
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
            <form.AppField name="baseUrl" validators={required('a base URL')}>
              {(field) => <field.InputField label="Base URL" type="url" placeholder="http://localhost:11434/v1" />}
            </form.AppField>
            <View className="flex-row items-end gap-2">
              <View className="min-w-0 flex-1">
                <form.AppField name="model" validators={required('a model')}>
                  {(field) => <field.InputField label="Model" placeholder="qwen3:14b" />}
                </form.AppField>
              </View>
              <ModelMenu
                agentId={agent?.id ?? null}
                baseUrl={() => form.getFieldValue('baseUrl')}
                onPick={(model) => {
                  form.setFieldValue('model', model.id);
                  if (model.contextLength && !form.getFieldValue('contextLength').trim()) {
                    form.setFieldValue('contextLength', String(model.contextLength));
                  }
                }}
              />
            </View>
            <form.AppField name="systemPrompt">
              {(field) => (
                <field.TextAreaField label="System prompt" placeholder="Optional. Who the agent is, in any lane." />
              )}
            </form.AppField>
            <form.AppField name="temperature" validators={{ onChange: numberRule({ min: 0, integer: false }) }}>
              {(field) => <field.InputField label="Temperature" inputMode="decimal" placeholder="Model default" />}
            </form.AppField>
            <form.AppField name="maxTokens" validators={{ onChange: numberRule({ min: 1 }) }}>
              {(field) => <field.InputField label="Max tokens" inputMode="numeric" placeholder="Model default" />}
            </form.AppField>
            <form.AppField name="contextLength" validators={{ onChange: numberRule({ min: 1 }) }}>
              {(field) => <field.InputField label="Context length" inputMode="numeric" placeholder="Model default" />}
            </form.AppField>
            <form.AppField name="maxToolIterations" validators={{ onChange: numberRule({ min: 1, required: true }) }}>
              {(field) => <field.InputField label="Max tool iterations" inputMode="numeric" />}
            </form.AppField>
            <form.AppField name="requestTimeoutSeconds" validators={{ onChange: numberRule({ min: 1 }) }}>
              {(field) => (
                <field.InputField label="Request timeout (seconds)" inputMode="numeric" placeholder="Default" />
              )}
            </form.AppField>
            <form.AppField name="maxRetries" validators={{ onChange: numberRule({ min: 0 }) }}>
              {(field) => <field.InputField label="Max retries" inputMode="numeric" placeholder="Default" />}
            </form.AppField>
            <form.AppField name="toolDiscovery">
              {(field) => (
                <field.CheckboxField
                  label="Tool discovery"
                  description="Offer the model only the tools a cheap first pass picks. For servers with more tools than a small context holds."
                />
              )}
            </form.AppField>
            <form.AppField name="toolSelectModel">
              {(field) => <field.InputField label="Tool selection model" placeholder="The agent's own model" />}
            </form.AppField>
            <form.AppField name="mcpServers">
              {(field) => <McpServerList servers={field.state.value} onChange={(next) => field.handleChange(next)} />}
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
 * reads the endpoint's `/models`, with the agent's stored key when it has one.
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
 * The agent's MCP servers, a row each. A URL is an HTTP server; a command is a
 * process the runner spawns, which it refuses unless its host has set
 * RUNNER_ALLOW_STDIO — the command would run there, with the runner's rights.
 */
function McpServerList({
  servers,
  onChange,
}: {
  servers: McpServerDraft[];
  onChange: (servers: McpServerDraft[]) => void;
}) {
  function patch(id: string, change: Partial<McpServerDraft>) {
    onChange(servers.map((server) => (server.id === id ? { ...server, ...change } : server)));
  }

  return (
    <View className="gap-2">
      <Text className="font-medium text-foreground text-sm">MCP servers</Text>
      <Text className="text-muted-foreground text-xs">
        Telos's own tools are always there. A command is refused by the runner unless its host sets RUNNER_ALLOW_STDIO,
        because it would run on that machine.
      </Text>
      {servers.map((server, index) => {
        const label = server.name.trim() || `Server ${index + 1}`;
        return (
          <View key={server.id} className="gap-2 rounded-lg border border-border px-3 py-2">
            <View className="flex-row items-center gap-2">
              <Input
                className="flex-1"
                value={server.name}
                aria-label={`${label} name`}
                placeholder="Name"
                onChangeText={(name) => patch(server.id, { name })}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${label}`}
                onPress={() => onChange(servers.filter((row) => row.id !== server.id))}
              >
                <X className="h-4 w-4" />
              </Button>
            </View>
            <Input
              value={server.url}
              type="url"
              aria-label={`${label} URL`}
              placeholder="URL, e.g. http://localhost:8080/mcp"
              onChangeText={(url) => patch(server.id, { url })}
            />
            <Input
              value={server.command}
              aria-label={`${label} command`}
              placeholder="Or a command (stdio)"
              onChangeText={(command) => patch(server.id, { command })}
            />
            {server.command.trim() ? (
              <Textarea
                value={server.args}
                aria-label={`${label} arguments`}
                placeholder="Arguments, one per line"
                rows={2}
                onChangeText={(args) => patch(server.id, { args })}
              />
            ) : null}
            <McpServerTest server={server} label={label} />
          </View>
        );
      })}
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onPress={() => onChange([...servers, emptyMcpServer()])}
      >
        <Plus className="h-4 w-4" />
        Add MCP server
      </Button>
    </View>
  );
}

/** How often a test's answer is asked for while the runner makes it. */
const PROBE_POLL_MS = 1000;

/**
 * Tests a server row as it stands, saved or not: the runner connects to it and
 * lists its tools, so what is found is what a run would find.
 */
function McpServerTest({ server, label }: { server: McpServerDraft; label: string }) {
  const [probeId, setProbeId] = useState<string | null>(null);
  const [ask, asking] = useMutation(TestMcpServerDocument);
  const query = useQuery(McpProbeDocument, {
    variables: { id: probeId ?? '' },
    skip: !probeId,
    fetchPolicy: 'network-only',
  });
  const probe = query.data?.mcpProbe;
  const done = !probeId || probe?.status === 'done' || (query.data && !probe);
  const { startPolling, stopPolling } = query;
  useEffect(() => {
    if (done) stopPolling();
    else startPolling(PROBE_POLL_MS);
  }, [done, startPolling, stopPolling]);

  async function test() {
    setProbeId(null);
    try {
      const { data } = await ask({ variables: { server: JSON.stringify(toStoredServer(server)) } });
      setProbeId(data?.testMcpServer.id ?? null);
    } catch {
      // Shown from the mutation's error.
    }
  }

  const empty = !server.url.trim() && !server.command.trim();
  let result: { text: string; failed: boolean } | null = null;
  if (asking.error) result = { text: describeError(asking.error), failed: true };
  else if (query.error) result = { text: describeError(query.error), failed: true };
  else if (probeId && query.data && !probe) result = { text: 'The test was forgotten; try again.', failed: true };
  else if (probe?.status === 'done' && !probe.ok)
    result = { text: probe.error ?? 'It could not be reached.', failed: true };
  else if (probe?.status === 'done') {
    const names = probe.tools.map((tool) => tool.name);
    result = {
      text: names.length
        ? `Reached. ${names.length} tool${names.length === 1 ? '' : 's'}: ${names.join(', ')}`
        : 'Reached, but it offers no tools.',
      failed: false,
    };
  } else if (probeId) result = { text: 'The runner is testing it…', failed: false };

  return (
    <View className="gap-1">
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={empty || asking.loading || !done}
        aria-label={`Test ${label}`}
        onPress={() => void test()}
      >
        Test
      </Button>
      {result ? (
        <Text
          role={result.failed ? 'alert' : 'status'}
          className={result.failed ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}
        >
          {result.text}
        </Text>
      ) : null}
    </View>
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
