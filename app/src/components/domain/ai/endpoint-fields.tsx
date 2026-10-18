import { useLazyQuery } from '@apollo/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ComboboxField } from '@/components/ui/combobox-field';
import { FieldWrapper, useFieldContext } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { describeError } from '@/lib/errors';
import { AgentModelsDocument } from '@/lib/graphql';
import { withOrphanOptions } from '@/lib/select-options';

// The endpoint first, then its models: the shape min-agent's Model panel has.
// A base URL is typed (and a key, if it wants one), its models are asked for,
// and the model is then picked from what it lists rather than typed from
// memory. Typing one in stays possible: into the list's search, or into a box
// for an endpoint that lists nothing.

/** A model as the endpoint lists it. */
export interface EndpointModel {
  id: string;
  contextLength?: number | null;
}

/** Known-good base URLs, as the line under the field says them. */
export const BASE_URL_HELP =
  'Any OpenAI-compatible server: Ollama http://localhost:11434/v1, LM Studio http://localhost:1234/v1, OpenAI https://api.openai.com/v1, OpenRouter https://openrouter.ai/api/v1.';

/**
 * The models one endpoint lists, asked for when told to.
 *
 * @param agentId - The agent being edited, whose stored key the server may use; null for a new one or the defaults.
 * @returns What was asked and what came back.
 */
export function useEndpointModels(agentId: string | null) {
  const [load, query] = useLazyQuery(AgentModelsDocument, { fetchPolicy: 'network-only' });
  const [asked, setAsked] = useState<{ baseUrl: string; apiKey: string } | null>(null);

  /**
   * Asks `baseUrl` for its models, with a key typed but not yet saved when there is one.
   * Asking the same endpoint with the same key again is left alone unless `force`.
   */
  function ask(baseUrl: string, apiKey: string, force = false) {
    const url = baseUrl.trim();
    const key = apiKey.trim();
    if (!url) return;
    if (!force && asked && asked.baseUrl === url && asked.apiKey === key) return;
    setAsked({ baseUrl: url, apiKey: key });
    void load({ variables: { baseUrl: url, agentId, apiKey: key || null } }).catch(() => undefined);
  }

  const done = asked !== null && !query.loading;
  return {
    ask,
    asked,
    loading: query.loading,
    error: done && query.error ? describeError(query.error) : null,
    /** Null until an answer is in: not asked, still asking, or refused. */
    models: done && !query.error ? (query.data?.agentModels ?? null) : null,
  };
}

export type EndpointModels = ReturnType<typeof useEndpointModels>;

/**
 * The line under the endpoint: a button to ask it for its models, and what it said.
 *
 * @param endpoint - What `useEndpointModels` holds.
 * @param onLoad - Asks again, with what the form holds now.
 * @param canLoad - Whether there is a base URL to ask, its own or inherited.
 */
export function EndpointStatus({
  endpoint,
  onLoad,
  canLoad,
}: {
  endpoint: EndpointModels;
  onLoad: () => void;
  canLoad: boolean;
}) {
  const { asked, loading, error, models } = endpoint;
  return (
    <View className="flex-row flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={!canLoad || loading}
        onPress={onLoad}
        content={loading ? 'Asking…' : asked ? 'Reload models' : 'Load models'}
      />
      {error ? (
        <>
          <Badge variant="destructive">Failed</Badge>
          <Text className="flex-1 text-negative text-xs" aria-live="polite">
            {error}
          </Text>
        </>
      ) : models ? (
        <>
          <Badge variant="positive">Connected</Badge>
          <Text className="flex-1 text-foreground/60 text-xs" aria-live="polite">
            {models.length === 1 ? '1 model' : `${models.length} models`} at {asked?.baseUrl}
          </Text>
        </>
      ) : !canLoad ? (
        <Text className="flex-1 text-foreground/60 text-xs">Give a base URL to list its models.</Text>
      ) : null}
    </View>
  );
}

/**
 * A model field: a searchable list of what the endpoint lists once it has listed
 * something, a text box until then. A name the list does not have can still be
 * typed into the list's search and used, and the first row leaves it blank.
 *
 * @param label - The field's label.
 * @param models - What the endpoint lists, or null while there is no list.
 * @param blankLabel - What the blank choice says: what it inherits, or that it is off.
 * @param placeholder - The text box's, for the same.
 * @param onPick - Told the model chosen when the list has it, for its context length.
 */
export function ModelField({
  label,
  models,
  blankLabel,
  placeholder,
  onPick,
}: {
  label: string;
  models: readonly EndpointModel[] | null;
  blankLabel: string;
  placeholder?: string;
  onPick?: (model: EndpointModel) => void;
}) {
  // Null once the list's blank row is chosen, which is what `clearable` writes.
  const field = useFieldContext<string | null>();
  const value = field.state.value ?? '';
  const listed = models !== null && models.length > 0;

  // The field wires the combobox's own change handler, so a choice is heard as the value moving.
  const last = useRef(value);
  useEffect(() => {
    if (value === last.current) return;
    last.current = value;
    const model = models?.find((entry) => entry.id === value);
    if (model) onPick?.(model);
  }, [value, models, onPick]);

  const options = useMemo(
    () =>
      withOrphanOptions(
        (models ?? []).map((model) => ({
          value: model.id,
          label: model.id,
          className: 'font-mono',
          meta: model.contextLength ? `${model.contextLength.toLocaleString()} ctx` : undefined,
        })),
        value.trim() === '' ? [] : [value],
      ),
    [models, value],
  );

  if (!listed) {
    return (
      <FieldWrapper
        label={label}
        controlSlot={
          <Input
            value={value}
            placeholder={placeholder}
            onBlur={field.handleBlur}
            onChangeText={(text) => field.handleChange(text)}
          />
        }
      />
    );
  }
  return (
    <ComboboxField
      label={label}
      options={options}
      searchable
      freeText
      searchPlaceholder="Find or type a model…"
      clearable
      emptyLabel={blankLabel}
    />
  );
}

/** A heading between a form's groups of fields. */
export function FormGroupTitle({ title, description }: { title: string; description?: string }) {
  return (
    <View className="gap-0.5 pt-2">
      <Text role="heading" aria-level={3} className="font-medium text-foreground text-sm">
        {title}
      </Text>
      {description ? <Text className="text-foreground/60 text-xs">{description}</Text> : null}
    </View>
  );
}
