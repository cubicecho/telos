import { useMutation } from '@apollo/client';
import { useRouter } from 'expo-router';
import { type ReactNode, useState } from 'react';
import { Text, View } from 'react-native';
import { ActionButton } from '@/components/action-button';
import { MessageSquare } from '@/components/app-icons';
import { ConfirmButton } from '@/components/confirm-button';
import { DescriptionList, PropertyRow } from '@/components/description-list';
import { AiSetupChecklist } from '@/components/domain/ai/ai-setup-checklist';
import { type ProjectActivity, ProjectActivityLine } from '@/components/domain/ai/project-activity';
import { ProjectAiSwitch, ProjectAutoRunSwitch } from '@/components/domain/ai/project-ai-switch';
import { DraftDialog } from '@/components/domain/draft/draft-dialog';
import { LabelBadge, type LabelSummary } from '@/components/domain/label/label-badge';
import { LabelPicker } from '@/components/domain/label/label-picker';
import { SaveTemplateDialog } from '@/components/domain/template/save-template-dialog';
import { PROSE_COLUMN } from '@/components/header-content-footer';
import { PageLayout } from '@/components/page-layout';
import { Copy, Pencil, Trash2 } from '@/components/ui/icons';
import { useAi } from '@/lib/ai';
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
  /** The project's AI switch. Meaningless, and not shown, unless AI is on for the account. */
  aiEnabled: boolean;
  /** Whether its stations start on todos by themselves. Means nothing, and is not shown, while its AI is off. */
  autoRun: boolean;
  labels: readonly LabelSummary[];
}

/**
 * A project's page: its name, description and actions in the header, its
 * counts and labels in the row under it, and whichever view is showing as the
 * body. The body is full width, for the board; the header keeps to the
 * reading column. The dialogs and mutations behind the header's buttons live here with
 * them.
 */
export function ProjectPage({
  project,
  content,
  activity,
}: {
  project: ProjectOverviewData;
  content: ReactNode;
  /** What its agents are doing, while AI is on for the account and the project. */
  activity?: ProjectActivity | undefined;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const ai = useAi();
  const canDraft = ai.on && project.aiEnabled;
  const [notice, setNotice] = useState<string | null>(null);
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
      return;
    }
    router.replace('/');
  }

  return (
    <PageLayout
      width="full"
      headerClassName={PROSE_COLUMN}
      title={project.name}
      description={project.description || undefined}
      action={
        <>
          <LabelPicker attached={project.labels} onToggle={toggleLabel} align="end" />
          {canDraft ? (
            <ActionButton
              variant="ghost"
              size="icon"
              onPress={() => {
                setNotice(null);
                setDrafting(true);
              }}
              label="Talk a request over"
            >
              <MessageSquare className="h-4 w-4" />
            </ActionButton>
          ) : null}
          <ActionButton
            variant="ghost"
            size="icon"
            onPress={() => {
              setNotice(null);
              setSavingTemplate(true);
            }}
            label="Save lanes as a template"
          >
            <Copy className="h-4 w-4" />
          </ActionButton>
          <ActionButton variant="ghost" size="icon" onPress={() => setEditing(true)} label="Edit project">
            <Pencil className="h-4 w-4" />
          </ActionButton>
          <ConfirmButton
            variant="ghost"
            size="icon"
            className="hover:text-destructive"
            label="Delete project"
            title={`Delete “${project.name}”?`}
            description={`Its ${project.todoCount} todo${project.todoCount === 1 ? '' : 's'} go with it. This cannot be undone.`}
            onConfirm={confirmDelete}
          >
            <Trash2 className="h-4 w-4" />
          </ConfirmButton>
        </>
      }
      headerContent={
        <View className="gap-3">
          <DescriptionList
            layout="stacked"
            className="flex-row gap-6"
            content={
              <>
                <Stat label="Open" value={project.openTodoCount} />
                <Stat label="Done" value={done} />
                <Stat label="Total" value={project.todoCount} />
              </>
            }
          />

          <ProjectAiSwitch projectId={project.id} enabled={project.aiEnabled} />
          {project.aiEnabled ? <ProjectAutoRunSwitch projectId={project.id} enabled={project.autoRun} /> : null}
          {activity ? <ProjectActivityLine activity={activity} /> : null}
          <AiSetupChecklist projectId={project.id} projectAi={project.aiEnabled} />

          {actionError ? (
            <Text className="text-destructive text-sm" aria-live="polite">
              {actionError}
            </Text>
          ) : null}
          {notice ? (
            <Text className="text-muted-foreground text-sm" aria-live="polite">
              {notice}
            </Text>
          ) : null}

          {/* Only the badges, so no row is drawn for a project that has none. */}
          {project.labels.length > 0 ? (
            <View className="flex-row flex-wrap gap-1">
              {project.labels.map((label) => (
                <LabelBadge key={label.id} label={label} onRemove={() => toggleLabel(label, false)} />
              ))}
            </View>
          ) : null}

          <ProjectFormDialog open={editing} onOpenChange={setEditing} project={project} />
          <SaveTemplateDialog
            open={savingTemplate}
            onOpenChange={setSavingTemplate}
            projectId={project.id}
            projectName={project.name}
            onSaved={(name) => setNotice(`Saved its lanes as the template “${name}”.`)}
          />

          {canDraft ? (
            <DraftDialog
              open={drafting}
              onOpenChange={setDrafting}
              projectId={project.id}
              onMade={(title) => setNotice(`Made the todo “${title}”.`)}
            />
          ) : null}
        </View>
      }
      content={content}
    />
  );
}

/** A count, as cubeui's `PropertyRow` drawn as a figure: a small label over a large number. */
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <PropertyRow
      label={label}
      value={value}
      labelClassName="text-xs uppercase tracking-wide"
      valueClassName="font-medium text-lg tabular-nums"
    />
  );
}
