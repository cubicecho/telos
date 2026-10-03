import { useMutation } from '@apollo/client';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Section } from '@/components/section';
import { SettingRow } from '@/components/setting-row';
import { Switch } from '@/components/ui/switch';
import { useAi } from '@/lib/ai';
import { describeError } from '@/lib/errors';
import { AiStateDocument, SetAiEnabledDocument, SetInstanceAiEnabledDocument } from '@/lib/graphql';
import { AgentDefaultsForm } from './agent-defaults-form';
import { AgentManager } from './agent-manager';
import { ApiKeyManager } from './api-key-manager';
import { LanePresetManager } from './lane-preset-manager';
import { RunRetention } from './run-retention';

/**
 * The AI switches, and the API keys an MCP client signs in with. The agents
 * and the MCP servers they reach have tabs of their own (AgentSettings, and
 * McpServerManager on the settings screen), there only while AI is on.
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
              <SettingRow
                title="AI on this instance"
                description="For everyone on this server; only admins see this. Turned off, no account can use AI, the MCP endpoint closes, and anything agents are working on is stopped."
                action={
                  <Switch
                    checked={ai.instance}
                    onCheckedChange={toggleInstance}
                    disabled={instanceLoading}
                    accessibilityLabel="AI on this instance"
                  />
                }
              />
            ) : null}
            {ai.instance ? (
              <SettingRow
                title="Use AI on this account"
                description="Lets AI clients reach your projects with an API key. Turned off, every key stops working and nothing AI is shown; your todos, notes and history are untouched."
                action={
                  <Switch
                    checked={ai.account}
                    onCheckedChange={toggle}
                    disabled={loading}
                    accessibilityLabel="Use AI on this account"
                  />
                }
              />
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
          <RunRetention />
        </>
      ) : null}
    </>
  );
}

/**
 * What the board's stations hand work to: the account's defaults every agent
 * inherits, the agents themselves, and the lane presets that pair an agent
 * with a job. Drawn only while AI is on.
 */
export function AgentSettings() {
  const ai = useAi();
  if (!ai.on) return null;
  return (
    <>
      <AgentDefaultsForm />
      <AgentManager />
      <LanePresetManager />
    </>
  );
}
