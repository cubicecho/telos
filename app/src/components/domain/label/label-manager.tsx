import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Text, View } from 'react-native';
import type { LabelSummary } from '@/components/domain/label/label-badge';
import { LabelFormDialog } from '@/components/domain/label/label-form-dialog';
import { Button } from '@/components/ui/button';
import { ColorDot } from '@/components/ui/color-dot';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Pencil, Plus, Trash2 } from '@/components/ui/icons';
import { LoadState } from '@/components/ui/load-failure';
import { describeError } from '@/lib/errors';
import { DeleteLabelDocument, LabelsDocument } from '@/lib/graphql';
import { cn, HOVER_REVEAL } from '@/lib/utils';

/** The whole label lifecycle in one block: list, create, rename, delete. */
export function LabelManager() {
  const labelsQuery = useQuery(LabelsDocument);
  const [editing, setEditing] = useState<LabelSummary | undefined>();
  const [formOpen, setFormOpen] = useState(false);
  const [deleting, setDeleting] = useState<LabelSummary | null>(null);
  const [deleteLabel] = useMutation(DeleteLabelDocument, { refetchQueries: [LabelsDocument] });
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const labels = labelsQuery.data?.labels ?? [];

  async function confirmDelete() {
    setDeleteError(null);
    try {
      if (deleting) await deleteLabel({ variables: { id: deleting.id } });
    } catch (cause) {
      setDeleteError(describeError(cause));
    }
    setDeleting(null);
  }

  return (
    <View className="gap-4">
      <View className="flex-row items-center justify-between">
        <View>
          <Text role="heading" aria-level={2} className="font-medium text-base text-foreground">
            Labels
          </Text>
          <Text className="mt-1 text-muted-foreground text-sm">Attach them to projects and todos alike.</Text>
        </View>
        <Button
          onPress={() => {
            setEditing(undefined);
            setFormOpen(true);
          }}
        >
          <Plus className="mr-1 h-4 w-4" />
          New label
        </Button>
      </View>

      {/* Kept outside the dialog: the dialog closes on the failure, and an
          error that vanishes with the thing that caused it was never read. */}
      {deleteError ? (
        <Text className="text-destructive text-sm" aria-live="polite">
          {deleteError}
        </Text>
      ) : null}

      <LoadState
        query={labelsQuery}
        what="your labels"
        count={labels.length}
        empty={<Text className="text-muted-foreground text-sm">No labels yet.</Text>}
      />
      {labels.length === 0 ? null : (
        <View role="list" className="gap-1">
          {labels.map((label) => (
            <View
              key={label.id}
              role="listitem"
              className="group flex-row items-center gap-3 rounded-lg border border-border bg-card px-3 py-2"
            >
              <ColorDot color={label.color} />
              <Text numberOfLines={1} className="flex-1 text-foreground text-sm">
                {label.name}
              </Text>
              <Button
                variant="ghost"
                size="icon"
                className={cn('h-8 w-8 focus-visible:opacity-100', HOVER_REVEAL)}
                aria-label={`Rename ${label.name}`}
                onPress={() => {
                  setEditing(label);
                  setFormOpen(true);
                }}
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={cn('h-8 w-8 hover:text-destructive focus-visible:opacity-100', HOVER_REVEAL)}
                aria-label={`Delete ${label.name}`}
                onPress={() => setDeleting(label)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </View>
          ))}
        </View>
      )}

      <LabelFormDialog open={formOpen} onOpenChange={setFormOpen} label={editing} />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete “${deleting?.name ?? ''}”?`}
        description="It is removed from every project and todo it is attached to. Nothing else is deleted."
        confirmLabel="Delete"
        onConfirm={confirmDelete}
      />
    </View>
  );
}
