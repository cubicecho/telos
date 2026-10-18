import { useApolloClient, useMutation } from '@apollo/client';
import { useStore } from '@tanstack/react-form';
import { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { List } from '@/components/list';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Form } from '@/components/ui/form';
import { describeError } from '@/lib/errors';
import { CreateMcpServerDocument, McpServersDocument, SetMcpServerSecretDocument } from '@/lib/graphql';
import { newId } from '@/lib/ids';
import { type PastedServer, readMcpJson } from '@/lib/mcp-json';

const PLACEHOLDER = '{\n  "mcpServers": {\n    "docs": { "type": "http", "url": "https://example.com/mcp" }\n  }\n}';

/**
 * Servers from a pasted `.mcp.json`: the block Claude Code, Claude Desktop and
 * most server READMEs give. What it finds is listed with what is wrong with
 * each, and the ones picked are created.
 *
 * Headers and env are secrets here, so each is set through `setMcpServerSecret`
 * once its server exists; the create never carries them. A command the runner
 * would spawn is only offered once commands are allowed, which starts off.
 */
export function McpJsonPasteDialog({
  open,
  onOpenChange,
  taken,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The slugs the account's servers have. */
  taken: string[];
}) {
  const client = useApolloClient();
  const [createServer] = useMutation(CreateMcpServerDocument);
  const [setSecret] = useMutation(SetMcpServerSecretDocument);
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const form = useAppForm({
    defaultValues: { json: '', allowStdio: false },
    onSubmit: () => add(),
  });
  const { json, allowStdio } = useStore(form.store, (state) => state.values);
  const found = useMemo(() => readMcpJson(json, { taken, allowStdio }), [json, taken, allowStdio]);
  const picked = found.servers.filter((server) => server.errors.length === 0 && !skipped.has(server.key));

  useEffect(() => {
    if (open) form.reset();
  }, [open, form]);

  async function add() {
    if (picked.length === 0) return;
    setBusy(true);
    setFailure(null);
    const done: string[] = [];
    try {
      for (const server of picked) {
        const id = newId();
        await step(server.key, 'it was not created', () =>
          createServer({ variables: { values: { id, ...server.values } } }),
        );
        done.push(server.key);
        for (const secret of server.secrets) {
          await step(server.key, `it was created, but ${secret.name} was not set`, () =>
            setSecret({ variables: { id, ...secret } }),
          );
        }
      }
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
      return;
    } finally {
      // Once, rather than per create: the list then shows what was made, and
      // the slug rule refuses those keys if the same paste is added again.
      if (done.length > 0) await client.refetchQueries({ include: [McpServersDocument] }).catch(() => undefined);
      setBusy(false);
    }
    onOpenChange(false);
  }

  function toggle(key: string, on: boolean) {
    setSkipped((current) => {
      const next = new Set(current);
      if (on) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const count = picked.length;
  return (
    <form.AppForm>
      <DialogLayout
        open={open}
        onOpenChange={onOpenChange}
        title="Paste .mcp.json"
        description="An mcpServers block, as Claude Code and most server READMEs give it. Each key becomes a server's slug."
        size="lg"
        hasUnsavedChanges={() => !form.state.isDefaultValue}
        footerSlot={
          failure ? (
            <Text role="alert" className="text-negative text-sm">
              {failure}
            </Text>
          ) : null
        }
        footerActionsSlot={(close) => (
          <>
            <Button variant="outline" onPress={close} content="Cancel" />
            <Button
              variant="positive"
              disabled={count === 0}
              loading={busy}
              onPress={() => void form.handleSubmit()}
              content={count === 1 ? 'Add 1 server' : `Add ${count} servers`}
            />
          </>
        )}
        contentSlot={
          <Form className="gap-4">
            <form.AppField name="json">
              {(field) => <field.TextAreaField label="JSON" autoFocus placeholder={PLACEHOLDER} rows={8} />}
            </form.AppField>
            <form.AppField name="allowStdio">
              {(field) => (
                <field.SwitchField
                  label="Allow commands (stdio)"
                  description="A command is started by the runner, on its host, with its rights. The runner also refuses one unless RUNNER_ALLOW_STDIO is set there."
                />
              )}
            </form.AppField>
            {found.error ? (
              <Text role="alert" className="text-negative text-sm">
                {found.error}
              </Text>
            ) : null}
            {found.servers.length > 0 ? (
              <List
                divided={false}
                contentSlot={found.servers.map((server) => (
                  <PastedServerRow
                    key={server.key}
                    server={server}
                    checked={server.errors.length === 0 && !skipped.has(server.key)}
                    onCheckedChange={(on) => toggle(server.key, on)}
                  />
                ))}
              />
            ) : null}
          </Form>
        }
      />
    </form.AppForm>
  );
}

/**
 * Runs one request of an import, turning its failure into one that says which
 * server it was on and how far it got.
 */
async function step(key: string, what: string, work: () => Promise<unknown>) {
  try {
    await work();
  } catch (cause) {
    throw new Error(`${key}: ${what}. ${describeError(cause)}`);
  }
}

/** `args`, which the API types as JSON. */
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** One server a paste holds: what it reaches, its secrets, and why it cannot be added. */
function PastedServerRow({
  server,
  checked,
  onCheckedChange,
}: {
  server: PastedServer;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const blocked = server.errors.length > 0;
  const secrets = server.secrets.length;
  return (
    <View className="flex-row items-start gap-3 rounded-lg border border-foreground/10 bg-secondary p-3">
      <View className="pt-0.5">
        <Checkbox
          checked={checked}
          disabled={blocked}
          onCheckedChange={onCheckedChange}
          accessibilityLabel={`Add ${server.key}`}
        />
      </View>
      <View className="flex-1 gap-1">
        <View className="flex-row flex-wrap items-center gap-2">
          <Text className="font-mono text-foreground text-sm">{server.key}</Text>
          <Badge variant="outline">{server.stdio ? 'Command' : 'URL'}</Badge>
          {secrets > 0 ? <Badge variant="secondary">{`${secrets} secret${secrets === 1 ? '' : 's'}`}</Badge> : null}
        </View>
        <Text numberOfLines={1} className="text-foreground/60 text-xs">
          {server.stdio ? [server.values.command, ...asList(server.values.args)].join(' ') : server.values.url}
        </Text>
        {server.errors.map((error) => (
          <Text key={error} className="text-negative text-xs">
            {error}
          </Text>
        ))}
        {server.warnings.map((warning) => (
          <Text key={warning} className="text-foreground/60 text-xs">
            {warning}
          </Text>
        ))}
      </View>
    </View>
  );
}
