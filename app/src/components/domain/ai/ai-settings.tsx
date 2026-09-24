import { useMutation } from '@apollo/client';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Section } from '@/components/section';
import { Field, FieldContent, FieldDescription, FieldTitle } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { useAi } from '@/lib/ai';
import { describeError } from '@/lib/errors';
import { SetAiEnabledDocument } from '@/lib/graphql';
import { ApiKeyManager } from './api-key-manager';

/**
 * The account's AI switch, and what it unlocks: the API keys an MCP client
 * signs in with.
 *
 * Drawn only when the instance has AI at all. Off at the account, it is the one
 * AI thing on the page — no keys, no project switches, no chips anywhere else —
 * and turning it off shuts every key this account has out, without deleting
 * them, so turning it back on is not a round of re-issuing keys.
 */
export function AiSettings() {
  const ai = useAi();
  const [setAiEnabled, { loading }] = useMutation(SetAiEnabledDocument);
  const [error, setError] = useState<string | null>(null);

  if (!ai.instance) return null;

  async function toggle(enabled: boolean) {
    setError(null);
    try {
      await setAiEnabled({
        variables: { enabled },
        ...(ai.userId
          ? { optimisticResponse: { setAiEnabled: { __typename: 'User' as const, id: ai.userId, aiEnabled: enabled } } }
          : {}),
      });
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  return (
    <>
      <Section
        surface="card"
        title="AI"
        description="Off unless you turn it on. Each project has its own switch as well."
        content={
          <View className="gap-3">
            <Field orientation="horizontal">
              <Switch
                checked={ai.account}
                onCheckedChange={toggle}
                disabled={loading}
                accessibilityLabel="Use AI on this account"
              />
              <FieldContent>
                <FieldTitle>Use AI on this account</FieldTitle>
                <FieldDescription>
                  Lets AI clients reach your projects with an API key. Turned off, every key stops working and nothing
                  AI is shown; your todos, notes and history are untouched.
                </FieldDescription>
              </FieldContent>
            </Field>
            {error ? (
              <Text className="text-destructive text-sm" aria-live="polite">
                {error}
              </Text>
            ) : null}
          </View>
        }
      />
      {ai.on ? <ApiKeyManager /> : null}
    </>
  );
}
