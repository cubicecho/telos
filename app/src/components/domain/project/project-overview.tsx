import { useMutation } from '@apollo/client';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { LabelBadge, type LabelSummary } from '@/components/domain/label/label-badge';
import { LabelPicker } from '@/components/domain/label/label-picker';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Pencil, Trash2 } from '@/components/ui/icons';
import { describeError } from '@/lib/errors';
import {
  AttachProjectLabelDocument,
  DeleteProjectDocument,
  DetachProjectLabelDocument,
  ProjectsDocument,
} from '@/lib/graphql';
import { ProjectFormDialog } from './project-form-dialog';

export interface ProjectOverviewData {
  id: string;
  name: string;
  description: string | null;
  todoCount: number;
  openTodoCount: number;
  labels: readonly LabelSummary[];
}

export function ProjectOverview({ project }: { project: ProjectOverviewData }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Attaching a label returns the project with its labels selected exactly as
  // this screen reads them, so the normalized entity updates itself. Deleting
  // still refetches: the sidebar's list is what changes, and a removed project
  // is not something the returned row can say.
  const [attachLabel] = useMutation(AttachProjectLabelDocument);
  const [detachLabel] = useMutation(DetachProjectLabelDocument);
  const [deleteProject] = useMutation(DeleteProjectDocument, { refetchQueries: [ProjectsDocument] });

  // Both of these used to reject into nothing: the badge would simply not
  // appear, or not disappear, and the reader was left to guess whether they
  // had missed the click. Same shape as the todo row's — the failure belongs
  // beside the control that caused it, not in a corner of the window.
  function run(action: () => Promise<unknown>) {
    setActionError(null);
    return action().then(
      () => undefined,
      (reason) => setActionError(describeError(reason)),
    );
  }

  function toggleLabel(label: LabelSummary, attach: boolean) {
    const variables = { projectId: project.id, labelId: label.id };
    return run(() => (attach ? attachLabel({ variables }) : detachLabel({ variables })));
  }

  const done = project.todoCount - project.openTodoCount;

  async function confirmDelete() {
    setActionError(null);
    try {
      await deleteProject({ variables: { id: project.id } });
    } catch (cause) {
      // Stay put. Navigating away from a project that is still
      // there would look like the delete worked.
      setActionError(describeError(cause));
      setConfirmingDelete(false);
      return;
    }
    router.replace('/');
  }

  return (
    <View role="banner" className="gap-3 border-border border-b pb-6">
      <View className="flex-row items-start justify-between gap-4">
        <View className="min-w-0 shrink">
          <Text
            role="heading"
            aria-level={1}
            numberOfLines={1}
            className="font-semibold text-2xl text-foreground tracking-tight"
          >
            {project.name}
          </Text>
          {project.description ? (
            <Text className="mt-1 text-muted-foreground text-sm">{project.description}</Text>
          ) : null}
        </View>
        <View className="shrink-0 flex-row items-center gap-1">
          <LabelPicker attached={project.labels} onToggle={toggleLabel} align="end" />
          <Button variant="ghost" size="icon" onPress={() => setEditing(true)} aria-label="Edit project">
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="hover:text-destructive"
            onPress={() => setConfirmingDelete(true)}
            aria-label="Delete project"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </View>
      </View>

      {/* Was a `<dl>`. A term/definition pair has no native counterpart and
          react-native-web has no role that renders one, so each stat is a
          group named by its term — which is what a screen reader said of the
          `<dl>` anyway: "Open, 3". */}
      <View className="flex-row gap-6">
        <Stat term="Open" value={project.openTodoCount} />
        <Stat term="Done" value={done} />
        <Stat term="Total" value={project.todoCount} />
      </View>

      {actionError ? (
        <Text className="text-destructive text-sm" aria-live="polite">
          {actionError}
        </Text>
      ) : null}

      {/* Only the badges now, so no row is drawn for a project that has none. */}
      {project.labels.length > 0 ? (
        <View className="flex-row flex-wrap gap-1">
          {project.labels.map((label) => (
            <LabelBadge key={label.id} label={label} onRemove={() => toggleLabel(label, false)} />
          ))}
        </View>
      ) : null}

      <ProjectFormDialog open={editing} onOpenChange={setEditing} project={project} />

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={`Delete “${project.name}”?`}
        description={`Its ${project.todoCount} todo${project.todoCount === 1 ? '' : 's'} go with it. This cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={confirmDelete}
      />
    </View>
  );
}

function Stat({ term, value }: { term: string; value: number }) {
  return (
    <View role="group" aria-label={`${term}, ${value}`}>
      <Text aria-hidden className="text-muted-foreground text-xs uppercase tracking-wide">
        {term}
      </Text>
      <Text aria-hidden className="font-medium text-foreground text-lg tabular-nums">
        {value}
      </Text>
    </View>
  );
}
