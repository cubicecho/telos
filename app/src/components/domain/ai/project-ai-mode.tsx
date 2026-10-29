import { useMutation } from '@apollo/client';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { AiMode } from '@/__generated__/graphql';
import { SegmentedButton, SegmentedGroup } from '@/components/ui/segmented';
import { useAi } from '@/lib/ai';
import { describeError } from '@/lib/errors';
import { SetProjectAiModeDocument } from '@/lib/graphql';

/** What follows a project's mode at once, where it is on screen: the board's cards and the setup checklist. */
const FOLLOWS_THE_MODE: readonly (string | undefined)[] = ['ProjectActivity', 'AiSetup'];

/** A project's run mode, as `projects.run_mode` stores it. */
export type RunMode = 'auto' | 'lane' | 'follow';

/** The four modes, in the order they are offered, each with what it means. */
const MODES: readonly { mode: AiMode; runMode: RunMode | null; label: string; says: string }[] = [
  { mode: AiMode.Off, runMode: null, label: 'Off', says: 'AI is off for this project' },
  { mode: AiMode.Auto, runMode: 'auto', label: 'Auto', says: 'Agents start on todos by themselves' },
  { mode: AiMode.Lane, runMode: 'lane', label: 'One lane', says: 'Agents work a todo one lane at a time, when asked' },
  { mode: AiMode.Follow, runMode: 'follow', label: 'Follow', says: 'Once run, a todo is worked through every lane' },
];

/**
 * The project's mode, from its two columns: off while its AI switch is, and
 * otherwise its run mode.
 */
export function aiModeOf(project: { aiEnabled: boolean; runMode: string }): AiMode {
  if (!project.aiEnabled) return AiMode.Off;
  return MODES.find((choice) => choice.runMode === project.runMode)?.mode ?? AiMode.Lane;
}

/**
 * How far AI works a project, the last of the three switches: off, every ready
 * todo by itself, one lane each time a person asks, or every lane once a
 * person has asked. Drawn only when the instance and the account both have AI
 * on; otherwise the project shows nothing AI at all. Off keeps the run mode, so
 * turning the project back on, or the account, restores the board as it was.
 */
export function ProjectAiModePicker({
  projectId,
  aiEnabled,
  runMode,
}: {
  projectId: string;
  aiEnabled: boolean;
  runMode: string;
}) {
  const ai = useAi();
  const [setMode, { loading }] = useMutation(SetProjectAiModeDocument, {
    refetchQueries: 'active',
    onQueryUpdated: (query) => FOLLOWS_THE_MODE.includes(query.queryName),
  });
  const [error, setError] = useState<string | null>(null);

  if (!ai.on) return null;

  const current = aiModeOf({ aiEnabled, runMode });

  async function choose(next: AiMode) {
    if (next === current) return;
    setError(null);
    const chosen = MODES.find((choice) => choice.mode === next);
    try {
      await setMode({
        variables: { projectId, mode: next },
        optimisticResponse: {
          setProjectAiMode: {
            __typename: 'Project',
            id: projectId,
            aiEnabled: next !== AiMode.Off,
            runMode: chosen?.runMode ?? runMode,
          },
        },
      });
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  return (
    <View className="gap-1">
      <View className="flex-row flex-wrap items-center gap-2">
        <SegmentedGroup aria-label="How far AI works this project" value={current} onValueChange={choose}>
          {MODES.map((choice) => (
            <SegmentedButton key={choice.mode} value={choice.mode} disabled={loading}>
              {choice.label}
            </SegmentedButton>
          ))}
        </SegmentedGroup>
        <Text className="text-foreground/60 text-sm">{MODES.find((choice) => choice.mode === current)?.says}</Text>
      </View>
      {error ? (
        <Text className="text-negative text-xs" aria-live="polite">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
