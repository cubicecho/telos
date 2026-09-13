import { useMutation, useQuery } from '@apollo/client';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { LabelSummary } from '@/components/domain/label/label-badge';
import { LabelFormDialog } from '@/components/domain/label/label-form-dialog';
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
import { LoadFailure } from '@/components/ui/load-failure';
import { Spinner } from '@/components/ui/spinner';
import { describeError } from '@/lib/errors';
import { DeleteLabelDocument, LabelsDocument } from '@/lib/graphql';

/** The whole label lifecycle in one block: list, create, rename, delete. */
export function LabelManager() {
  const { data, loading, error, refetch } = useQuery(LabelsDocument);
  const [editing, setEditing] = useState<LabelSummary | undefined>();
  const [formOpen, setFormOpen] = useState(false);
  const [deleting, setDeleting] = useState<LabelSummary | null>(null);
  const [deleteLabel] = useMutation(DeleteLabelDocument, { refetchQueries: [LabelsDocument] });
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const labels = data?.labels ?? [];

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="font-medium text-base">Labels</h2>
          <p className="mt-1 text-muted-foreground text-sm">Attach them to projects and todos alike.</p>
        </div>
        <Button
          onClick={() => {
            setEditing(undefined);
            setFormOpen(true);
          }}
        >
          <Plus className="mr-1 h-4 w-4" />
          New label
        </Button>
      </header>

      {/* Kept outside the dialog: the dialog closes on the failure, and an
          error that vanishes with the thing that caused it was never read. */}
      {deleteError ? (
        <p className="text-destructive text-sm" aria-live="polite">
          {deleteError}
        </p>
      ) : null}

      {loading && labels.length === 0 ? (
        <Spinner />
      ) : error && labels.length === 0 ? (
        <LoadFailure error={error} onRetry={refetch} />
      ) : labels.length === 0 ? (
        <p className="text-muted-foreground text-sm">No labels yet.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {labels.map((label) => (
            <div key={label.id} className="group flex items-center gap-3 rounded-lg border bg-card px-3 py-2">
              <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: label.color }} />
              <span className="flex-1 truncate text-sm">{label.name}</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                aria-label={`Rename ${label.name}`}
                onClick={() => {
                  setEditing(label);
                  setFormOpen(true);
                }}
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                aria-label={`Delete ${label.name}`}
                onClick={() => setDeleting(label)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <LabelFormDialog open={formOpen} onOpenChange={setFormOpen} label={editing} />

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              It is removed from every project and todo it is attached to. Nothing else is deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                setDeleteError(null);
                try {
                  if (deleting) await deleteLabel({ variables: { id: deleting.id } });
                } catch (cause) {
                  setDeleteError(describeError(cause));
                }
                setDeleting(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
