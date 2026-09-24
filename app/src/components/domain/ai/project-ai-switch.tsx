import { useMutation } from '@apollo/client';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Switch } from '@/components/ui/switch';
import { useAi } from '@/lib/ai';
import { describeError } from '@/lib/errors';
import { SetProjectAiEnabledDocument } from '@/lib/graphql';

/**
 * A project's own AI switch, the third of the three. Drawn only when the
 * instance and the account both have AI on; otherwise the project shows nothing
 * AI at all, whatever its flag says. Its flag is kept when the account is
 * turned off, so turning the account back on restores the projects as they were.
 */
export function ProjectAiSwitch({ projectId, enabled }: { projectId: string; enabled: boolean }) {
  const ai = useAi();
  const [setEnabled, { loading }] = useMutation(SetProjectAiEnabledDocument);
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
