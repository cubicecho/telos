import { useMutation } from '@apollo/client';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Section } from '@/components/section';
import { Field, FieldContent, FieldDescription, FieldTitle } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { useAi } from '@/lib/ai';
import { describeError } from '@/lib/errors';
import { AiStateDocument, SetAiEnabledDocument, SetInstanceAiEnabledDocument } from '@/lib/graphql';
import { AgentManager } from './agent-manager';
import { ApiKeyManager } from './api-key-manager';

/**
 * The AI switches, and what they unlock: the API keys an MCP client signs in
 * with, and the agents the board's stations hand work to.
 *
 * An admin sees the instance's switch first, whenever the server offers AI.
 * Everyone else sees this card only once the instance has AI on. Off at the
 * account, the account's switch is the one AI thing on the page — no keys, no
 * project switches, no chips anywhere else — and turning it off shuts every
 * key this account has out, without deleting them, so turning it back on is
 * not a round of re-issuing keys.
 */
export function AiSettings() {
  const ai = useAi();
  const [setAiEnabled, { loading }] = useMutation(SetAiEnabledDocument);
  // The instance's switch changes what every AI screen draws, and the answer is
  // `authConfig`, which has no id to update in place: ask again instead.
  const [setInstanceAiEnabled, { loading: instanceLoading }] = useMutation(SetInstanceAiEnabledDocument, {
    refetchQueries: [AiStateDocument],
    awaitRefetchQueries: true,
  });
  const [error, setError] = useState<string | null>(null);

  const adminSwitch = ai.admin && ai.available;
  if (!ai.settings) return null;

  async function toggleInstance(enabled: boolean) {
    setError(null);
    try {
      await setInstanceAiEnabled({ variables: { enabled } });
    } catch (cause) {
      setError(describeError(cause));
    }
  }

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
            {adminSwitch ? (
              <Field orientation="horizontal">
                <Switch
                  checked={ai.instance}
                  onCheckedChange={toggleInstance}
                  disabled={instanceLoading}
                  accessibilityLabel="AI on this instance"
                />
                <FieldContent>
                  <FieldTitle>AI on this instance</FieldTitle>
                  <FieldDescription>
                    For everyone on this server; only admins see this. Turned off, no account can use AI, the MCP
                    endpoint closes, and anything agents are working on is stopped.
                  </FieldDescription>
                </FieldContent>
              </Field>
            ) : null}
            {ai.instance ? (
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
            ) : null}
            {error ? (
              <Text className="text-destructive text-sm" aria-live="polite">
                {error}
              </Text>
            ) : null}
          </View>
        }
      />
      {ai.on ? (
        <>
          <ApiKeyManager />
          <AgentManager />
        </>
      ) : null}
    </>
  );
}
