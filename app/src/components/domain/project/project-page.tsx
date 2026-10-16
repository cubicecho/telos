import { useMutation } from '@apollo/client';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { DescriptionList, PropertyRow } from '@/components/description-list';
import { AiSetupChecklist } from '@/components/domain/ai/ai-setup-checklist';
import type { ProjectActivity } from '@/components/domain/ai/project-activity';
import { LabelBadge, type LabelSummary } from '@/components/domain/label/label-badge';
import { LabelPicker } from '@/components/domain/label/label-picker';
import { SaveTemplateDialog } from '@/components/domain/template/save-template-dialog';
import { HeaderContentFooter } from '@/components/header-content-footer';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Copy, Ellipsis, Pencil, Trash2 } from '@/components/ui/icons';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import { describeError } from '@/lib/errors';
import {
  AttachProjectLabelDocument,
  DeleteProjectDocument,
  DetachProjectLabelDocument,
  ProjectsDocument,
} from '@/lib/graphql';
import type { SlotNode } from '@/lib/utils';
import { ProjectBar } from './project-bar';
import { ProjectFormDialog } from './project-form-dialog';

export interface ProjectOverviewData {
  id: string;
  name: string;
  description: string | null;
  todoCount: number;
  openTodoCount: number;
  /** The project's AI switch, flipped in the bar under its header. Meaningless, and not shown, unless AI is on for the account. */
  aiEnabled: boolean;
  /** Whether its lanes' agents start on todos by themselves. Means nothing, and is not shown, while its AI is off. */
  autoRun: boolean;
  /** The lane new todos land in, or null for the first open lane. */
  newTodoLaneId: string | null;
  labels: readonly LabelSummary[];
}

/**
 * A project's page: its name, description, counts and actions in the header,
 * the AI bar under it, and whichever view is showing as the body. All of it
 * runs the full width of the pane. The dialogs and mutations behind the
 * header's buttons live here with them.
 *
 * It is `PageLayout` written out — the chassis with a `PageHeader` in its
 * header — because the bar is a second row of that header and runs edge to
 * edge, which `PageLayout`'s one header slot has no place for.
 */
export function ProjectPage({
  project,
  content,
  activity,
}: {
  project: ProjectOverviewData;
  content: SlotNode;
  /** What its agents are doing, while AI is on for the account and the project. */
  activity?: ProjectActivity | undefined;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
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

  const pinned = actionError || notice || project.labels.length > 0;

  return (
    <>
      <HeaderContentFooter
        width="full"
        className="h-full"
        headerSlot={
          <>
            <PageHeader
              title={project.name}
              description={project.description || undefined}
              actionSlot={
                <>
                  {/* Beside the title rather than under it, so the views get the height. */}
                  <DescriptionList
                    layout="stacked"
                    className="mr-2 flex-row gap-6"
                    contentSlot={
                      <>
                        <Stat label="Open" value={project.openTodoCount} />
                        <Stat label="Done" value={done} />
                        <Stat label="Total" value={project.todoCount} />
                      </>
                    }
                  />
                  <LabelPicker attached={project.labels} onToggle={toggleLabel} align="end" />
                  {/* One button for everything done to the project itself, so the
                  header reads as its name and its numbers rather than a row of icons. */}
                  <Menu>
                    <MenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Project actions"
                        iconSlot={<Ellipsis className="h-4 w-4" />}
                      />
                    </MenuTrigger>
                    <MenuContent align="end" className="w-56" aria-label="Project actions">
                      <MenuItem
                        label="Save lanes as a template"
                        iconSlot={<Copy className="h-3.5 w-3.5" />}
                        onSelect={() => {
                          setNotice(null);
                          setSavingTemplate(true);
                        }}
                      />
                      <MenuItem
                        label="Edit project"
                        iconSlot={<Pencil className="h-3.5 w-3.5" />}
                        onSelect={() => setEditing(true)}
                      />
                      <MenuItem
                        label="Delete project"
                        destructive
                        iconSlot={<Trash2 className="h-3.5 w-3.5" />}
                        onSelect={() => setConfirmingDelete(true)}
                      />
                    </MenuContent>
                  </Menu>
                </>
              }
            />
            <ProjectBar project={project} activity={activity} />

            {/* Pinned with the header: what a header button did or failed to do
            is read from wherever the body has scrolled to. No row is drawn
            when there is nothing to say. */}
            {pinned ? (
              <View className="gap-2 px-4 pt-3">
                {actionError ? (
                  <Text className="text-negative text-sm" aria-live="polite">
                    {actionError}
                  </Text>
                ) : null}
                {notice ? (
                  <Text className="text-foreground/60 text-sm" aria-live="polite">
                    {notice}
                  </Text>
                ) : null}
                {project.labels.length > 0 ? (
                  <View className="flex-row flex-wrap gap-1">
                    {project.labels.map((label) => (
                      <LabelBadge key={label.id} label={label} onRemove={() => toggleLabel(label, false)} />
                    ))}
                  </View>
                ) : null}
              </View>
            ) : null}
          </>
        }
        contentSlot={
          <>
            {/* In the body, so a list of steps does not take the board's height for good. */}
            <AiSetupChecklist className="mx-4 mt-4" projectId={project.id} projectAi={project.aiEnabled} />
            {content}
          </>
        }
      />

      <ProjectFormDialog open={editing} onOpenChange={setEditing} project={project} />
      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={`Delete “${project.name}”?`}
        description={`Its ${project.todoCount} todo${project.todoCount === 1 ? '' : 's'} go with it. This cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={() => {
          setConfirmingDelete(false);
          confirmDelete();
        }}
      />
      <SaveTemplateDialog
        open={savingTemplate}
        onOpenChange={setSavingTemplate}
        projectId={project.id}
        projectName={project.name}
        onSaved={(name) => setNotice(`Saved its lanes as the template “${name}”.`)}
      />
    </>
  );
}

/** A count, as cubeui's `PropertyRow` drawn as a figure: a small label over a large number. */
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <PropertyRow
      label={label}
      value={value}
      labelClassName="text-xs uppercase tracking-wider"
      valueClassName="font-medium text-lg tabular-nums"
    />
  );
}
