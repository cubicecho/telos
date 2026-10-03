import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { McpSecretKind, type McpServerFieldsFragment } from '@/__generated__/graphql';
import { ActionButton } from '@/components/action-button';
import { useAppForm } from '@/components/app-form';
import { ConfirmButton } from '@/components/confirm-button';
import { Section } from '@/components/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Form } from '@/components/ui/form';
import { FormDialog, FormDialogFooter } from '@/components/ui/form-dialog';
import { Pencil, Plus, Trash2, X } from '@/components/ui/icons';
import { LoadState } from '@/components/ui/load-failure';
import { Switch } from '@/components/ui/switch';
import { readServerSlugs } from '@/lib/agents';
import { formatShortDate } from '@/lib/dates';
import { describeError } from '@/lib/errors';
import {
  AgentsDocument,
  CreateMcpServerDocument,
  DeleteMcpServerDocument,
  McpProbeDocument,
  McpServersDocument,
  SetMcpServerSecretDocument,
  TestMcpServerDocument,
  UpdateMcpServerDocument,
} from '@/lib/graphql';
import { newId } from '@/lib/ids';
import {
  fromServerDraft,
  hooksRule,
  type McpServerDraft,
  readTools,
  secondsRule,
  slugRule,
  toServerDraft,
} from '@/lib/mcp-servers';

type ServerRow = McpServerFieldsFragment;

/** An agent, as far as saying who reaches a server needs. */
interface AgentUse {
  name: string;
  mcpServerSlugs: unknown;
}

/**
 * The account's MCP servers: the tool servers its agents may reach, kept once
 * here and named by each agent. Rendered only while AI is on, as agents are.
 *
 * A server's headers and environment are secrets. They have their own dialog,
 * which can only say which are set: their values go to the runner and nowhere
 * else.
 */
export function McpServerManager() {
  const serversQuery = useQuery(McpServersDocument);
  const agentsQuery = useQuery(AgentsDocument);
  const [editing, setEditing] = useState<ServerRow | 'new' | null>(null);
  const [keying, setKeying] = useState<string | null>(null);
  const [deleteServer] = useMutation(DeleteMcpServerDocument, { refetchQueries: [McpServersDocument] });
  const [updateServer] = useMutation(UpdateMcpServerDocument);
  const [error, setError] = useState<string | null>(null);

  const servers = serversQuery.data?.mcpServers ?? [];
  const agents = agentsQuery.data?.agents ?? [];
  const keyed = servers.find((server) => server.id === keying) ?? null;

  async function run(work: () => Promise<unknown>) {
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  async function confirmDelete(server: ServerRow) {
    await run(() => deleteServer({ variables: { id: server.id } }));
  }

  return (
    <Section
      surface="card"
      title="MCP servers"
      description="Tool servers your agents can reach. Kept once here; each agent says which it uses."
      action={
        <Button size="sm" onPress={() => setEditing('new')}>
          <Plus className="h-4 w-4" />
          New server
        </Button>
      }
      content={
        <View className="gap-4">
          {error ? (
            <Text className="text-destructive text-sm" aria-live="polite">
              {error}
            </Text>
          ) : null}

          <LoadState
            query={serversQuery}
            what="your MCP servers"
            count={servers.length}
            empty={<Text className="text-muted-foreground text-sm">No servers yet.</Text>}
          />
          {servers.length === 0 ? null : (
            <View role="list" className="gap-1">
              {servers.map((server) => (
                <View key={server.id} role="listitem" className="gap-2 rounded-lg border border-border bg-card p-3">
                  <View className="flex-row items-center gap-3">
                    <View className="flex-1 gap-0.5">
                      <Text numberOfLines={1} className="text-foreground text-sm">
                        {server.name}
                        <Text className="font-mono text-muted-foreground"> {server.slug}</Text>
                      </Text>
                      <Text numberOfLines={1} className="text-muted-foreground text-xs">
                        {server.url ?? server.command}
                      </Text>
                    </View>
                    <Switch
                      checked={server.enabled}
                      onCheckedChange={(enabled) =>
                        run(() =>
                          updateServer({
                            variables: { id: server.id, set: { enabled } },
                            optimisticResponse: { updateMcpServer: { ...server, enabled } },
                          }),
                        )
                      }
                      accessibilityLabel={`${server.name} on`}
                    />
                    <ActionButton
                      variant="ghost"
                      size="icon-sm"
                      label={`Edit ${server.name}`}
                      onPress={() => setEditing(server)}
                    >
                      <Pencil className="h-4 w-4" />
                    </ActionButton>
                    <ConfirmButton
                      variant="ghost"
                      size="icon-sm"
                      className="hover:text-destructive"
                      label={`Delete ${server.name}`}
                      title={`Delete “${server.name}”?`}
                      description="Its secrets go with it. An agent that names it carries on without it, and says so on its runs. This cannot be undone."
                      confirmLabel="Delete"
                      onConfirm={() => confirmDelete(server)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </ConfirmButton>
                  </View>
                  <Text className="text-muted-foreground text-xs">{describeUse(server, agents)}</Text>
                  <View className="flex-row flex-wrap items-center gap-2">
                    <Button variant="outline" size="sm" onPress={() => setKeying(server.id)}>
                      Secrets
                    </Button>
                    <Badge variant={secretCount(server) > 0 ? 'secondary' : 'outline'}>{describeSecrets(server)}</Badge>
                  </View>
                  <McpServerTest server={server} />
                </View>
              ))}
            </View>
          )}

          {/* Keyed so switching from one server to another starts a fresh form. */}
          {editing ? (
            <McpServerFormDialog
              key={editing === 'new' ? 'new' : editing.id}
              open
              onOpenChange={(open) => !open && setEditing(null)}
              server={editing === 'new' ? null : editing}
              taken={servers.filter((server) => editing === 'new' || server.id !== editing.id).map((row) => row.slug)}
            />
          ) : null}

          {keyed ? (
            <McpServerSecretsDialog open onOpenChange={(open) => !open && setKeying(null)} server={keyed} />
          ) : null}
        </View>
      }
    />
  );
}

/**
 * Which agents reach a server: those that name it, and those that name none in
 * particular and so reach them all.
 *
 * @param server - The server.
 * @param agents - The account's agents.
 * @returns One line.
 */
function describeUse(server: ServerRow, agents: AgentUse[]): string {
  if (server.enabled === false) return 'Switched off: no agent reaches it.';
  const users = agents.filter((agent) => readServerSlugs(agent.mcpServerSlugs)?.includes(server.slug) ?? true);
  if (users.length === 0) return 'No agent uses it.';
  return `Used by ${users.map((agent) => agent.name).join(', ')}.`;
}

const secretCount = (server: ServerRow) => server.headerNames.length + server.envNames.length;

function describeSecrets(server: ServerRow): string {
  const count = secretCount(server);
  if (count === 0) return 'No secrets';
  return `${count} secret${count === 1 ? '' : 's'} set`;
}

/** How often a test's answer is asked for while the runner makes it. */
const PROBE_POLL_MS = 1000;

/**
 * Tests a server as it is saved: the runner connects to it with its secrets
 * and lists its tools, so what is found is what a run would find. What it
 * finds is kept on the server, and is what is shown until the next test.
 */
function McpServerTest({ server }: { server: ServerRow }) {
  const [probeId, setProbeId] = useState<string | null>(null);
  const [ask, asking] = useMutation(TestMcpServerDocument);
  const query = useQuery(McpProbeDocument, {
    variables: { id: probeId ?? '' },
    skip: !probeId,
    fetchPolicy: 'network-only',
  });
  const servers = useQuery(McpServersDocument, { fetchPolicy: 'cache-only' });
  const probe = query.data?.mcpProbe;
  const done = !probeId || probe?.status === 'done' || (query.data && !probe);
  const finished = probeId !== null && probe?.status === 'done';
  const { startPolling, stopPolling } = query;
  const { refetch } = servers;
  useEffect(() => {
    if (done) stopPolling();
    else startPolling(PROBE_POLL_MS);
  }, [done, startPolling, stopPolling]);
  // The answer is also on the server's row by now: read it, so the row and the
  // agents' pickers say the same thing.
  useEffect(() => {
    if (finished) void refetch().catch(() => undefined);
  }, [finished, refetch]);

  async function test() {
    setProbeId(null);
    try {
      const { data } = await ask({ variables: { id: server.id } });
      setProbeId(data?.testMcpServer.id ?? null);
    } catch {
      // Shown from the mutation's error.
    }
  }

  let result: { text: string; failed: boolean };
  if (asking.error) result = { text: describeError(asking.error), failed: true };
  else if (query.error) result = { text: describeError(query.error), failed: true };
  else if (probeId && query.data && !probe) result = { text: 'The test was forgotten; try again.', failed: true };
  else if (probe?.status === 'done' && !probe.ok)
    result = { text: probe.error ?? 'It could not be reached.', failed: true };
  else if (probe?.status === 'done')
    result = { text: describeTools(probe.tools.map((tool) => tool.name)), failed: false };
  else if (probeId) result = { text: 'The runner is testing it…', failed: false };
  else result = describeCheck(server);

  return (
    <View className="flex-row items-start gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={asking.loading || !done}
        aria-label={`Test ${server.name}`}
        onPress={() => void test()}
      >
        Test
      </Button>
      <Text
        role={result.failed ? 'alert' : 'status'}
        className={
          result.failed ? 'flex-1 pt-1.5 text-destructive text-xs' : 'flex-1 pt-1.5 text-muted-foreground text-xs'
        }
      >
        {result.text}
      </Text>
    </View>
  );
}

function describeTools(names: string[]): string {
  return names.length
    ? `Reached. ${names.length} tool${names.length === 1 ? '' : 's'}: ${names.join(', ')}`
    : 'Reached, but it offers no tools.';
}

/**
 * What the last test found, from the server's row.
 *
 * @param server - The server.
 * @returns What to say, and whether it is a failure.
 */
function describeCheck(server: ServerRow): { text: string; failed: boolean } {
  if (!server.checkedAt) return { text: 'Never tested.', failed: false };
  const when = formatShortDate(server.checkedAt);
  if (server.checkOk === false) {
    return { text: `Failed ${when}: ${server.checkError ?? 'it could not be reached.'}`, failed: true };
  }
  return { text: `${describeTools(readTools(server.tools).map((tool) => tool.name))} (${when})`, failed: false };
}

/**
 * Creating a server or editing one. Everything but its secrets, which are
 * write-only and have their own dialog.
 *
 * A URL is an HTTP server; a command is a process the runner spawns, which it
 * refuses unless its host has set RUNNER_ALLOW_STDIO — the command would run
 * there, with the runner's rights.
 */
export function McpServerFormDialog({
  open,
  onOpenChange,
  server,
  taken,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  server: ServerRow | null;
  /** The slugs the account's other servers have. */
  taken: string[];
}) {
  const isEdit = server !== null;
  const [createServer, createState] = useMutation(CreateMcpServerDocument, { refetchQueries: [McpServersDocument] });
  const [updateServer, updateState] = useMutation(UpdateMcpServerDocument);
  const [targetError, setTargetError] = useState<string | null>(null);
  const error = createState.error ?? updateState.error;
  const initial = useMemo(() => toServerDraft(server), [server]);
  const form = useAppForm({
    defaultValues: initial,
    onSubmit: ({ value }) => save(value),
  });

  useEffect(() => {
    if (open) form.reset(initial);
  }, [open, initial, form]);

  async function save(value: McpServerDraft) {
    if (value.url.trim() === '' && value.command.trim() === '') {
      setTargetError('A server needs a URL or a command.');
      return;
    }
    setTargetError(null);
    const values = fromServerDraft(value);
    try {
      if (server) await updateServer({ variables: { id: server.id, set: values } });
      else await createServer({ variables: { values: { id: newId(), ...values } } });
    } catch {
      // `error` says why, beside the buttons; what was typed stays.
      return;
    }
    onOpenChange(false);
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? `Edit ${server.name}` : 'New MCP server'}
      description="A URL for an HTTP server, or a command for one the runner starts itself."
      className="sm:max-w-[560px]"
    >
      <form.AppForm>
        <Form className="gap-4">
          {/* Padding is room for a field's focus ring, which a scroll area would clip. */}
          <ScrollView className="-m-1 max-h-[60vh]" contentContainerClassName="gap-4 p-1">
            <form.AppField name="name">
              {(field) => <field.InputField label="Name" autoFocus placeholder="Team memory" />}
            </form.AppField>
            <form.AppField name="slug" validators={{ onChange: slugRule(taken) }}>
              {(field) => (
                <View className="gap-1">
                  <field.InputField label="Slug" placeholder="memory" />
                  <Hint>
                    What its tools are named under, as slug__tool, and what an agent's list holds. Renaming it follows
                    into those lists.
                  </Hint>
                </View>
              )}
            </form.AppField>
            <form.AppField name="url">
              {(field) => <field.InputField label="URL" type="url" placeholder="http://localhost:8080/mcp" />}
            </form.AppField>
            <form.AppField name="command">
              {(field) => (
                <View className="gap-1">
                  <field.InputField label="Or a command (stdio)" placeholder="npx" />
                  <Hint>
                    Refused by the runner unless its host sets RUNNER_ALLOW_STDIO, because it would run on that machine.
                  </Hint>
                </View>
              )}
            </form.AppField>
            <form.AppField name="args">
              {(field) => <field.TextAreaField label="Arguments" placeholder="For a command, one per line" rows={2} />}
            </form.AppField>
            <form.AppField name="cwd">
              {(field) => (
                <View className="gap-1">
                  <field.InputField label="Working directory" placeholder="/srv/files" />
                  <Hint>Where a command runs, on the runner's host. Blank is the runner's own directory.</Hint>
                </View>
              )}
            </form.AppField>
            <View className="gap-1">
              <View className="flex-row gap-3">
                <View className="flex-1">
                  <form.AppField name="connectTimeout" validators={{ onChange: secondsRule(false) }}>
                    {(field) => <field.InputField label="Connect (s)" inputMode="decimal" placeholder="Default" />}
                  </form.AppField>
                </View>
                <View className="flex-1">
                  <form.AppField name="callTimeout" validators={{ onChange: secondsRule(false) }}>
                    {(field) => <field.InputField label="Call (s)" inputMode="decimal" placeholder="Default" />}
                  </form.AppField>
                </View>
                <View className="flex-1">
                  <form.AppField name="idleTimeout" validators={{ onChange: secondsRule(true) }}>
                    {(field) => <field.InputField label="Idle (s)" inputMode="decimal" placeholder="Default" />}
                  </form.AppField>
                </View>
              </View>
              <Hint>
                How long it gets to start and list its tools, to answer one call, and to sit unused before it is closed
                (0 keeps it open). Blank is the runner's default.
              </Hint>
            </View>
            <form.AppField name="hiddenTools">
              {(field) => (
                <View className="gap-1">
                  <field.TextAreaField label="Hidden tools" placeholder="One tool name per line" rows={2} />
                  <Hint>Tools the model is not offered. A hook can still call them.</Hint>
                </View>
              )}
            </form.AppField>
            <form.AppField name="hooks" validators={{ onChange: hooksRule }}>
              {(field) => (
                <View className="gap-1">
                  <field.TextAreaField
                    label="Hooks"
                    placeholder='[{ "id": "memory", "on": "beforeTurn", "tool": "recall", "inject": true }]'
                    rows={4}
                  />
                  <Hint>A JSON list of calls the runner makes around a run. One it cannot use is said on the run.</Hint>
                </View>
              )}
            </form.AppField>
          </ScrollView>
          <FormDialogFooter
            onCancel={() => onOpenChange(false)}
            error={targetError ?? (error ? describeError(error) : null)}
          >
            <form.SubmitButton isEdit={isEdit} createLabel="Create server" editLabel="Save" />
          </FormDialogFooter>
        </Form>
      </form.AppForm>
    </FormDialog>
  );
}

/** A line under a field saying what it is for. */
function Hint({ children }: { children: string }) {
  return <Text className="text-muted-foreground text-xs">{children}</Text>;
}

const SECRET_KINDS = [
  { label: 'Header', value: McpSecretKind.Header },
  { label: 'Environment variable', value: McpSecretKind.Env },
] as const;

/**
 * A server's secrets: the headers sent to a URL, and the environment a command
 * is started with. Set and removed one at a time. A value is never read back —
 * not here, not anywhere but the runner's claim — so the dialog can only name
 * what is stored.
 */
function McpServerSecretsDialog({
  open,
  onOpenChange,
  server,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  server: ServerRow;
}) {
  const [setSecret, { loading }] = useMutation(SetMcpServerSecretDocument);
  const [error, setError] = useState<string | null>(null);
  const form = useAppForm({
    defaultValues: { kind: (server.url ? McpSecretKind.Header : McpSecretKind.Env) as string, name: '', value: '' },
    onSubmit: ({ value }) => add(value),
  });

  async function run(work: () => Promise<unknown>): Promise<boolean> {
    setError(null);
    try {
      await work();
      return true;
    } catch (cause) {
      setError(describeError(cause));
      return false;
    }
  }

  async function add({ kind, name, value }: { kind: string; name: string; value: string }) {
    const secretKind = kind === McpSecretKind.Env ? McpSecretKind.Env : McpSecretKind.Header;
    const saved = await run(() =>
      setSecret({ variables: { id: server.id, kind: secretKind, name: name.trim(), value } }),
    );
    if (saved) form.reset({ kind, name: '', value: '' });
  }

  const stored = [
    ...server.headerNames.map((name) => ({ kind: McpSecretKind.Header, name, what: 'Header' })),
    ...server.envNames.map((name) => ({ kind: McpSecretKind.Env, name, what: 'Environment variable' })),
  ];

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Secrets for ${server.name}`}
      description="Headers sent to its URL, and the environment its command starts with. A value cannot be shown again; setting a name that is there replaces it."
    >
      <View className="gap-4">
        {stored.length === 0 ? (
          <Text className="text-muted-foreground text-sm">None set.</Text>
        ) : (
          <View role="list" className="gap-1">
            {stored.map((secret) => (
              <View
                key={`${secret.kind}:${secret.name}`}
                role="listitem"
                className="flex-row items-center gap-2 rounded-lg border border-border px-3 py-1.5"
              >
                <View className="flex-1 gap-0.5">
                  <Text numberOfLines={1} className="font-mono text-foreground text-sm">
                    {secret.name}
                  </Text>
                  <Text className="text-muted-foreground text-xs">{secret.what}</Text>
                </View>
                <ActionButton
                  variant="ghost"
                  size="icon-sm"
                  disabled={loading}
                  label={`Remove ${secret.name}`}
                  onPress={() =>
                    run(() =>
                      setSecret({ variables: { id: server.id, kind: secret.kind, name: secret.name, value: null } }),
                    )
                  }
                >
                  <X className="h-4 w-4" />
                </ActionButton>
              </View>
            ))}
          </View>
        )}
        <form.AppForm>
          <Form className="gap-4">
            <form.AppField name="kind">
              {(field) => <field.SelectField label="Kind" options={SECRET_KINDS} />}
            </form.AppField>
            <form.AppField
              name="name"
              validators={{ onChange: ({ value }) => (value.trim() === '' ? 'A secret needs a name.' : undefined) }}
            >
              {(field) => <field.InputField label="Name" placeholder="Authorization" />}
            </form.AppField>
            <form.AppField
              name="value"
              validators={{ onChange: ({ value }) => (value === '' ? 'Paste a value.' : undefined) }}
            >
              {(field) => <field.PasswordField label="Value" />}
            </form.AppField>
            <FormDialogFooter onCancel={() => onOpenChange(false)} cancelLabel="Done" error={error}>
              <form.SubmitButton createLabel="Set secret" disabled={loading} />
            </FormDialogFooter>
          </Form>
        </form.AppForm>
      </View>
    </FormDialog>
  );
}
