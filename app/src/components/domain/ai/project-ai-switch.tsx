import { useMutation } from '@apollo/client';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Switch } from '@/components/ui/switch';
import { useAi } from '@/lib/ai';
import { describeError } from '@/lib/errors';
import { SetProjectAiEnabledDocument, SetProjectAutoRunDocument } from '@/lib/graphql';

/** What follows a project's switches at once, where it is on screen: the board's cards and the setup checklist. */
const FOLLOWS_THE_SWITCHES: readonly (string | undefined)[] = ['ProjectActivity', 'AiSetup'];

/**
 * A project's own AI switch, the third of the three. Drawn only when the
 * instance and the account both have AI on; otherwise the project shows nothing
 * AI at all, whatever its flag says. Its flag is kept when the account is
 * turned off, so turning the account back on restores the projects as they were.
 */
export function ProjectAiSwitch({ projectId, enabled }: { projectId: string; enabled: boolean }) {
  const ai = useAi();
  const [setEnabled, { loading }] = useMutation(SetProjectAiEnabledDocument, {
    refetchQueries: 'active',
    onQueryUpdated: (query) => FOLLOWS_THE_SWITCHES.includes(query.queryName),
  });
  const [error, setError] = useState<string | null>(null);

  if (!ai.on) return null;

  async function toggle(next: boolean) {
    setError(null);
    try {
      await setEnabled({
        variables: { projectId, enabled: next },
        optimisticResponse: { setProjectAiEnabled: { __typename: 'Project', id: projectId, aiEnabled: next } },
      });
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  return (
    <View className="gap-1">
      <View className="flex-row items-center gap-2">
        <Switch
          checked={enabled}
          onCheckedChange={toggle}
          disabled={loading}
          accessibilityLabel="AI works on this project"
        />
        <Text className="text-muted-foreground text-sm">
          {enabled ? 'AI works on this project' : 'AI is off for this project'}
        </Text>
      </View>
      {error ? (
        <Text className="text-destructive text-xs" aria-live="polite">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Whether a project's agents start on todos by themselves, apart from
 * whether AI works on it at all. Off, a todo is worked only when a person asks
 * for it to be run. Drawn only while the project's AI is on: the page decides
 * that, and without it the switch would say nothing true.
 */
export function ProjectAutoRunSwitch({ projectId, enabled }: { projectId: string; enabled: boolean }) {
  const ai = useAi();
  // The board's cards say which todos wait to be run, so they follow the switch
  // now rather than at the next poll, and so does the setup checklist. By name
  // among the active ones: the switch is also drawn where neither is.
  const [setEnabled, { loading }] = useMutation(SetProjectAutoRunDocument, {
    refetchQueries: 'active',
    onQueryUpdated: (query) => FOLLOWS_THE_SWITCHES.includes(query.queryName),
  });
  const [error, setError] = useState<string | null>(null);

  if (!ai.on) return null;

  async function toggle(next: boolean) {
    setError(null);
    try {
      await setEnabled({
        variables: { projectId, enabled: next },
        optimisticResponse: { setProjectAutoRun: { __typename: 'Project', id: projectId, autoRun: next } },
      });
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  return (
    <View className="gap-1">
      <View className="flex-row items-center gap-2">
        <Switch
          checked={enabled}
          onCheckedChange={toggle}
          disabled={loading}
          accessibilityLabel="Agents start on todos by themselves"
        />
        <Text className="text-muted-foreground text-sm">
          {enabled ? 'Agents start on todos by themselves' : 'Agents wait to be asked'}
        </Text>
      </View>
      {error ? (
        <Text className="text-destructive text-xs" aria-live="polite">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
