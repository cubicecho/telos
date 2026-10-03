import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { useAppForm } from '@/components/app-form';
import { Section } from '@/components/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Form } from '@/components/ui/form';
import { FormDialog, FormDialogFooter } from '@/components/ui/form-dialog';
import { LoadState } from '@/components/ui/load-failure';
import { fromLayerDraft, type LayerDraft, layerHints, toLayerDraft } from '@/lib/agents';
import { describeError } from '@/lib/errors';
import { AgentDefaultsDocument, SetAgentDefaultsApiKeyDocument, SetAgentDefaultsDocument } from '@/lib/graphql';
import { DISCOVERY_HELP, discoveryOptions, NUMBER_FIELDS } from './agent-settings-fields';

/**
 * What every agent of this account inherits: the endpoint, the model and the
 * rest, each used by an agent that leaves it blank. A field blank here falls
 * to the runner's own default, which its placeholder shows.
 *
 * The default key is write-only, as an agent's is, and is sent only to the
 * default endpoint: an agent with a base URL of its own never gets it.
 */
export function AgentDefaultsForm() {
  const query = useQuery(AgentDefaultsDocument);
  const defaults = query.data?.agentDefaults;
  const [setDefaults, { error }] = useMutation(SetAgentDefaultsDocument);
  const [keying, setKeying] = useState(false);
  const [saved, setSaved] = useState(false);
  const hints = layerHints(defaults?.builtIn, 'built-in');
  const initial = useMemo(() => toLayerDraft(defaults), [defaults]);
  const form = useAppForm({
    defaultValues: initial,
    onSubmit: ({ value }) => save(value),
  });

  useEffect(() => {
    form.reset(initial);
  }, [initial, form]);

  async function save(value: LayerDraft) {
    setSaved(false);
    try {
      await setDefaults({ variables: { values: fromLayerDraft(value) } });
    } catch {
      // `error` says why, beside the button; what was typed stays.
      return;
    }
    setSaved(true);
  }

  return (
    <Section
      surface="card"
      title="Agent defaults"
      description="What every agent inherits for a field it leaves blank. Zero is a value: only a blank inherits."
      action={
        defaults ? (
          <View className="flex-row items-center gap-2">
            <Badge variant={defaults.hasApiKey ? 'secondary' : 'outline'}>
              {defaults.hasApiKey ? 'Key set' : 'No key'}
            </Badge>
            <Button variant="outline" size="sm" onPress={() => setKeying(true)}>
              {defaults.hasApiKey ? 'Replace default key' : 'Set default key'}
            </Button>
          </View>
        ) : null
      }
      content={
        <View className="gap-4">
          <LoadState query={query} what="your agent defaults" count={defaults ? 1 : 0} />
          {defaults ? (
            <form.AppForm>
              <Form className="gap-4">
                <form.AppField name="baseUrl">
                  {(field) => <field.InputField label="Base URL" type="url" placeholder="http://localhost:11434/v1" />}
                </form.AppField>
                <form.AppField name="model">
                  {(field) => <field.InputField label="Model" placeholder="qwen3:14b" />}
                </form.AppField>
                <View className="flex-row flex-wrap gap-4">
                  {NUMBER_FIELDS.map((spec) => (
                    <View key={spec.name} className="min-w-[160px] flex-1">
                      <form.AppField name={spec.name} validators={{ onChange: spec.rule }}>
                        {(field) => (
                          <field.InputField
                            label={spec.label}
                            inputMode={spec.inputMode}
                            placeholder={hints[spec.name]}
                          />
                        )}
                      </form.AppField>
                    </View>
                  ))}
                </View>
                <form.AppField name="toolDiscovery">
                  {(field) => (
                    <field.SelectField label="Tool discovery" options={discoveryOptions(hints.toolDiscovery)} />
                  )}
                </form.AppField>
                <Text className="-mt-2 text-muted-foreground text-xs">{DISCOVERY_HELP}</Text>
                <form.AppField name="toolSelectModel">
                  {(field) => <field.InputField label="Tool selection model" placeholder={hints.toolSelectModel} />}
                </form.AppField>
                <View className="flex-row items-center justify-end gap-3">
                  {error ? (
                    <Text className="flex-1 text-destructive text-sm" aria-live="polite">
                      {describeError(error)}
                    </Text>
                  ) : saved ? (
                    <Text className="flex-1 text-muted-foreground text-sm" aria-live="polite">
                      Saved.
                    </Text>
                  ) : null}
                  <form.SubmitButton isEdit editLabel="Save defaults" />
                </View>
              </Form>
            </form.AppForm>
          ) : null}
          {keying && defaults ? (
            <DefaultKeyDialog open onOpenChange={setKeying} hasApiKey={defaults.hasApiKey} />
          ) : null}
        </View>
      }
    />
  );
}

/**
 * Setting, replacing or clearing the default key. Like an agent's, it is never
 * read back, so the dialog can only say whether one is stored.
 */
function DefaultKeyDialog({
  open,
  onOpenChange,
  hasApiKey,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasApiKey: boolean;
}) {
  const [setKey, { error, loading }] = useMutation(SetAgentDefaultsApiKeyDocument);
  const form = useAppForm({
    defaultValues: { apiKey: '' },
    onSubmit: ({ value }) => save(value.apiKey.trim()),
  });

  async function save(apiKey: string | null) {
    try {
      await setKey({ variables: { apiKey } });
    } catch {
      return;
    }
    onOpenChange(false);
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Default API key"
      description={
        hasApiKey
          ? 'A key is set. A new one replaces it; it cannot be shown. It is sent only to the default base URL.'
          : 'No key is set. It is sent only to the default base URL, for agents without a key of their own.'
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
              hasApiKey ? (
                <Button variant="ghost" className="text-destructive" disabled={loading} onPress={() => save(null)}>
                  Clear key
                </Button>
              ) : null
            }
          >
            <form.SubmitButton createLabel={hasApiKey ? 'Replace key' : 'Set key'} disabled={loading} />
          </FormDialogFooter>
        </Form>
      </form.AppForm>
    </FormDialog>
  );
}
