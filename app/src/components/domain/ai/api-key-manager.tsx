import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useAppForm } from '@/components/app-form';
import { Section } from '@/components/section';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Form } from '@/components/ui/form';
import { FormDialog, FormDialogFooter } from '@/components/ui/form-dialog';
import { Plus, Trash2 } from '@/components/ui/icons';
import { LoadState } from '@/components/ui/load-failure';
import { formatShortDate } from '@/lib/dates';
import { describeError } from '@/lib/errors';
import { ApiKeysDocument, CreateApiKeyDocument, DeleteApiKeyDocument } from '@/lib/graphql';

const EXPIRY_OPTIONS = [
  { label: 'Never', value: 'never' },
  { label: '30 days', value: '30' },
  { label: '90 days', value: '90' },
  { label: 'A year', value: '365' },
] as const;

interface KeyRow {
  id: string;
  name: string | null;
  start: string | null;
  createdAt: string;
  lastRequest: string | null;
  expiresAt: string | null;
}

/**
 * API keys: what an MCP client such as Claude Code signs in with. Rendered only
 * while the account's AI switch is on, since the server refuses every field
 * here otherwise.
 */
export function ApiKeyManager() {
  const keysQuery = useQuery(ApiKeysDocument);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<KeyRow | null>(null);
  const [deleteKey] = useMutation(DeleteApiKeyDocument, { refetchQueries: [ApiKeysDocument] });
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const keys = keysQuery.data?.apiKeys ?? [];

  async function confirmDelete() {
    setDeleteError(null);
    try {
      if (deleting) await deleteKey({ variables: { id: deleting.id } });
    } catch (cause) {
      setDeleteError(describeError(cause));
    }
    setDeleting(null);
  }

  return (
    <Section
      surface="card"
      title="API keys"
      description="For MCP clients. A key acts as you, and only while AI is on."
      action={
        <Button size="sm" onPress={() => setCreating(true)}>
          <Plus className="h-4 w-4" />
          New key
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
            query={keysQuery}
            what="your API keys"
            count={keys.length}
            empty={<Text className="text-muted-foreground text-sm">No keys yet.</Text>}
          />
          {keys.length === 0 ? null : (
            <View role="list" className="gap-1">
              {keys.map((key) => (
                <View
                  key={key.id}
                  role="listitem"
                  className="flex-row items-center gap-3 rounded-lg border border-border bg-card px-3 py-2"
                >
                  <View className="flex-1 gap-0.5">
                    <Text numberOfLines={1} className="text-foreground text-sm">
                      {key.name || 'Unnamed key'}
                      {key.start ? <Text className="font-mono text-muted-foreground"> {key.start}…</Text> : null}
                    </Text>
                    <Text className="text-muted-foreground text-xs">{describeKey(key)}</Text>
                  </View>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="hover:text-destructive"
                    aria-label={`Revoke ${key.name || 'key'}`}
                    onPress={() => setDeleting(key)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </View>
              ))}
            </View>
          )}

          <CreateApiKeyDialog open={creating} onOpenChange={setCreating} />

          <ConfirmDialog
            open={deleting !== null}
            onOpenChange={(open) => !open && setDeleting(null)}
            title={`Revoke “${deleting?.name || 'this key'}”?`}
            description="Anything signed in with it stops working at once. This cannot be undone."
            confirmLabel="Revoke"
            onConfirm={confirmDelete}
          />
        </View>
      }
    />
  );
}

function describeKey(key: KeyRow): string {
  const parts = [`Created ${formatShortDate(key.createdAt)}`];
  parts.push(key.lastRequest ? `last used ${formatShortDate(key.lastRequest)}` : 'never used');
  if (key.expiresAt) parts.push(`expires ${formatShortDate(key.expiresAt)}`);
  return parts.join(' · ');
}

/**
 * Names a key and mints it, then shows it — once. Only a hash is stored, so
 * the dialog's second state is the only place the key will ever be readable.
 */
function CreateApiKeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [createKey, { error }] = useMutation(CreateApiKeyDocument, { refetchQueries: [ApiKeysDocument] });
  const [minted, setMinted] = useState<string | null>(null);
  const form = useAppForm({
    defaultValues: { name: '', expiry: 'never' as string },
    onSubmit: ({ value }) => mint(value),
  });

  useEffect(() => {
    if (!open) return;
    setMinted(null);
    form.reset({ name: '', expiry: 'never' });
  }, [open, form]);

  async function mint({ name, expiry }: { name: string; expiry: string }) {
    try {
      const result = await createKey({
        variables: { name: name.trim(), expiresInDays: expiry === 'never' ? null : Number(expiry) },
      });
      setMinted(result.data?.createApiKey.key ?? null);
    } catch {
      // `error` says why, beside the buttons; what was typed stays.
    }
  }

  if (minted) {
    return (
      <FormDialog
        open={open}
        onOpenChange={onOpenChange}
        title="Your new key"
        description="Copy it now. Only a hash is kept, so it cannot be shown again."
      >
        <View className="gap-4">
          <Text selectable className="rounded-md bg-muted px-3 py-2 font-mono text-foreground text-sm">
            {minted}
          </Text>
          <View className="flex-row justify-end">
            <Button onPress={() => onOpenChange(false)}>Done</Button>
          </View>
        </View>
      </FormDialog>
    );
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New API key"
      description="Name it after where it will live, so you know which to revoke."
    >
      <form.AppForm>
        <Form className="gap-4">
          <form.AppField
            name="name"
            validators={{ onChange: ({ value }) => (value.trim() === '' ? 'A key needs a name.' : undefined) }}
          >
            {(field) => <field.InputField label="Name" autoFocus placeholder="Claude Code on my laptop" />}
          </form.AppField>
          <form.AppField name="expiry">
            {(field) => <field.SelectField label="Expires" options={EXPIRY_OPTIONS} />}
          </form.AppField>
          <FormDialogFooter onCancel={() => onOpenChange(false)} error={error ? describeError(error) : null}>
            <form.SubmitButton createLabel="Create key" />
          </FormDialogFooter>
        </Form>
      </form.AppForm>
    </FormDialog>
  );
}
