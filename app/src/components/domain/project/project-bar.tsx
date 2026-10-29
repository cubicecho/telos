import { View } from 'react-native';
import { type ProjectActivity, ProjectActivityLine } from '@/components/domain/ai/project-activity';
import { ProjectAiModePicker } from '@/components/domain/ai/project-ai-mode';
import { useAi } from '@/lib/ai';

/**
 * The strip under a project's header: how far AI works on it (off, auto, one
 * lane, follow) at the start, and what its agents are doing and have spent at
 * the far end.
 *
 * The switch was in the edit dialog, two presses from a board going at the
 * wrong work. It is here because that is stopped in a hurry, from whichever
 * view it was noticed on, and the count beside it says what turning it off
 * leaves running.
 *
 * Nothing is drawn while AI is off for the account: a project's page says
 * nothing about AI to someone who left it off.
 */
export function ProjectBar({
  project,
  activity,
}: {
  project: { id: string; aiEnabled: boolean; runMode: string };
  /** What its agents are doing, while AI is on for the account and the project. */
  activity?: ProjectActivity | undefined;
}) {
  const ai = useAi();
  if (!ai.on) return null;

  return (
    <View
      role="region"
      aria-label="AI on this project"
      className="flex-row flex-wrap items-center justify-between gap-x-6 gap-y-1 border-foreground/10 border-b bg-secondary px-4 py-1.5"
    >
      <View className="flex-row flex-wrap items-center gap-x-6 gap-y-1">
        <ProjectAiModePicker projectId={project.id} aiEnabled={project.aiEnabled} runMode={project.runMode} />
      </View>
      {activity ? <ProjectActivityLine activity={activity} /> : null}
    </View>
  );
}
