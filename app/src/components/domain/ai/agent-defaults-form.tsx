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
import {
  DISCOVERY_HELP,
  discoveryOptions,
  EFFORT_HELP,
  effortOptions,
  type NumberGroup,
  numbersIn,
} from './agent-settings-fields';
import { BASE_URL_HELP, EndpointStatus, FormGroupTitle, ModelField, useEndpointModels } from './endpoint-fields';

/** The form's values: the defaults, and a key typed for them, which is saved on its own. */
type DefaultsFormValues = LayerDraft & { apiKey: string };

/**
 * What every agent of this account inherits: the endpoint, the model and the
 * rest, each used by an agent that leaves it blank. A field blank here falls
 * to the runner's own default, which its placeholder shows. Endpoint first, as
 * an agent's form is: its models are listed from it, to pick from.
 *
 * The default key is write-only, as an agent's is, and is sent only to the
 * default endpoint: an agent with a base URL of its own never gets it. Blank
 * keeps what is stored; clearing it is the key dialog's job.
 */
export function AgentDefaultsForm() {
  const query = useQuery(AgentDefaultsDocument);
  const defaults = query.data?.agentDefaults;
  const [setDefaults, { error }] = useMutation(SetAgentDefaultsDocument);
  const [setKey, keyState] = useMutation(SetAgentDefaultsApiKeyDocument);
  const [keying, setKeying] = useState(false);
  const [saved, setSaved] = useState(false);
  const hints = layerHints(defaults?.builtIn, 'built-in');
  const endpoint = useEndpointModels(null);
  const initial = useMemo<DefaultsFormValues>(() => ({ ...toLayerDraft(defaults), apiKey: '' }), [defaults]);
  const form = useAppForm({
    defaultValues: initial,
    onSubmit: ({ value }) => save(value),
  });

  useEffect(() => {
    form.reset(initial);
  }, [initial, form]);

  const askModels = (force = false) => endpoint.ask(form.getFieldValue('baseUrl'), form.getFieldValue('apiKey'), force);

  // The stored endpoint's models are listed as soon as it is known.
  const storedBaseUrl = defaults?.baseUrl;
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked once the stored endpoint is known
  useEffect(() => {
    if (storedBaseUrl) askModels();
  }, [storedBaseUrl]);

  async function save({ apiKey, ...value }: DefaultsFormValues) {
    setSaved(false);
    try {
      await setDefaults({ variables: { values: fromLayerDraft(value) } });
      if (apiKey.trim()) {
        await setKey({ variables: { apiKey: apiKey.trim() } });
        form.setFieldValue('apiKey', '');
      }
    } catch {
      // `error` says why, beside the button; what was typed stays.
      return;
    }
    setSaved(true);
  }

  const failure = error ?? keyState.error;
  const numbers = (group: NumberGroup) => (
    <View className="flex-row flex-wrap gap-4">
      {numbersIn(group).map((spec) => (
        <View key={spec.name} className="min-w-[160px] flex-1">
          <form.AppField name={spec.name} validators={{ onChange: spec.rule }}>
            {(field) => (
              <field.InputField label={spec.label} inputMode={spec.inputMode} placeholder={hints[spec.name]} />
            )}
          </form.AppField>
        </View>
      ))}
    </View>
  );

  return (
    <Section
      surface="card"
      title="Agent defaults"
      description="What every agent inherits for a field it leaves blank. Zero is a value: only a blank inherits."
      actionSlot={
        defaults ? (
          <View className="flex-row items-center gap-2">
            <Badge variant={defaults.hasApiKey ? 'secondary' : 'outline'}>
              {defaults.hasApiKey ? 'Key set' : 'No key'}
            </Badge>
            <Button
              variant="outline"
              size="sm"
              onPress={() => setKeying(true)}
              content={defaults.hasApiKey ? 'Replace default key' : 'Set default key'}
            />
          </View>
        ) : null
      }
      contentSlot={
        <View className="gap-4">
          <LoadState query={query} what="your agent defaults" count={defaults ? 1 : 0} />
          {defaults ? (
            <form.AppForm>
              <Form className="gap-4">
                <FormGroupTitle title="Endpoint" description="Where agents run unless they name their own." />
                <form.AppField name="baseUrl" listeners={{ onBlur: () => askModels() }}>
                  {(field) => <field.InputField label="Base URL" type="url" placeholder="http://localhost:11434/v1" />}
                </form.AppField>
                <Text className="-mt-2 text-muted-foreground text-xs">{BASE_URL_HELP}</Text>
                <form.AppField name="apiKey" listeners={{ onBlur: () => askModels() }}>
                  {(field) => (
                    <field.PasswordField
                      label="API key"
                      placeholder={
                        defaults.hasApiKey
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
                      canLoad={Boolean(baseUrl.trim())}
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
                      blankLabel="None"
                      placeholder="qwen3:14b"
                      onPick={(model) => {
                        if (model.contextLength && !form.getFieldValue('contextLength').trim()) {
                          form.setFieldValue('contextLength', String(model.contextLength));
                        }
                      }}
                    />
                  )}
                </form.AppField>
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

                <FormGroupTitle title="Tools" />
                {numbers('tools')}
                <form.AppField name="toolDiscovery">
                  {(field) => (
                    <field.SelectField label="Tool discovery" options={discoveryOptions(hints.toolDiscovery)} />
                  )}
                </form.AppField>
                <Text className="-mt-2 text-muted-foreground text-xs">{DISCOVERY_HELP}</Text>
                <form.AppField name="toolSelectModel">
                  {() => (
                    <ModelField
                      label="Tool selection model"
                      models={endpoint.models}
                      blankLabel="None"
                      placeholder={hints.toolSelectModel}
                    />
                  )}
                </form.AppField>

                <FormGroupTitle title="Requests" />
                {numbers('requests')}

                <View className="flex-row items-center justify-end gap-3">
                  {failure ? (
                    <Text className="flex-1 text-destructive text-sm" aria-live="polite">
                      {describeError(failure)}
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
            {(field) => <field.PasswordField label="API key" autoFocus />}
          </form.AppField>
          <FormDialogFooter
            onCancel={() => onOpenChange(false)}
            error={error ? describeError(error) : null}
            secondarySlot={
              hasApiKey ? (
                <Button
                  variant="ghost"
                  className="text-destructive"
                  disabled={loading}
                  onPress={() => save(null)}
                  content="Clear key"
                />
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
