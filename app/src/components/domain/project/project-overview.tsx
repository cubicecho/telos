import { useMutation } from '@apollo/client';
import { useRouter } from 'expo-router';
import { Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { LabelBadge, type LabelSummary } from '@/components/domain/label/label-badge';
import { LabelPicker } from '@/components/domain/label/label-picker';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  AttachProjectLabelDocument,
  DeleteProjectDocument,
  DetachProjectLabelDocument,
  ProjectDocument,
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

  const refetchQueries = [{ query: ProjectDocument, variables: { id: project.id } }, ProjectsDocument];
  const [attachLabel] = useMutation(AttachProjectLabelDocument, { refetchQueries });
  const [detachLabel] = useMutation(DetachProjectLabelDocument, { refetchQueries });
  const [deleteProject] = useMutation(DeleteProjectDocument, { refetchQueries: [ProjectsDocument] });

  function toggleLabel(label: LabelSummary, attach: boolean) {
    const variables = { projectId: project.id, labelId: label.id };
    return attach ? attachLabel({ variables }) : detachLabel({ variables });
  }

  const done = project.todoCount - project.openTodoCount;

  return (
    <header className="flex flex-col gap-3 border-b pb-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate font-semibold text-2xl tracking-tight">{project.name}</h1>
          {project.description ? <p className="mt-1 text-muted-foreground text-sm">{project.description}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <LabelPicker attached={project.labels} onToggle={toggleLabel} align="end" />
          <Button variant="ghost" size="icon" onClick={() => setEditing(true)} aria-label="Edit project">
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => setConfirmingDelete(true)}
            aria-label="Delete project"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <dl className="flex gap-6 text-sm">
        <div>
          <dt className="text-muted-foreground text-xs uppercase tracking-wide">Open</dt>
          <dd className="font-medium tabular-nums text-lg">{project.openTodoCount}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs uppercase tracking-wide">Done</dt>
          <dd className="font-medium tabular-nums text-lg">{done}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs uppercase tracking-wide">Total</dt>
          <dd className="font-medium tabular-nums text-lg">{project.todoCount}</dd>
        </div>
      </dl>

      {/* Only the badges now, so no row is drawn for a project that has none. */}
      {project.labels.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {project.labels.map((label) => (
            <LabelBadge key={label.id} label={label} onRemove={() => toggleLabel(label, false)} />
          ))}
        </div>
      ) : null}

      <ProjectFormDialog open={editing} onOpenChange={setEditing} project={project} />

      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{project.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Its {project.todoCount} todo{project.todoCount === 1 ? '' : 's'} go with it. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                await deleteProject({ variables: { id: project.id } });
                router.replace('/');
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </header>
  );
}
