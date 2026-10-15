import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { ConfirmButton } from '@/components/confirm-button';
import type { LabelSummary } from '@/components/domain/label/label-badge';
import { LabelFormDialog } from '@/components/domain/label/label-form-dialog';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { Section } from '@/components/section';
import { Button } from '@/components/ui/button';
import { ColorDot } from '@/components/ui/color-dot';
import { Pencil, Plus, Tag, Trash2 } from '@/components/ui/icons';
import { LoadState } from '@/components/ui/load-failure';
import { describeError } from '@/lib/errors';
import { DeleteLabelDocument, LabelsDocument } from '@/lib/graphql';
import { CARD_TITLE } from '@/lib/styles';
import { cn, HOVER_REVEAL } from '@/lib/utils';

/**
 * The whole label lifecycle in one block: list, create, rename, delete.
 *
 * It draws its own `Section`, because the "New label" button in the header and
 * the dialog it opens share this component's state.
 */
export function LabelManager() {
  const labelsQuery = useQuery(LabelsDocument);
  const [editing, setEditing] = useState<LabelSummary | undefined>();
  const [formOpen, setFormOpen] = useState(false);
  const [deleteLabel] = useMutation(DeleteLabelDocument, { refetchQueries: [LabelsDocument] });
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const labels = labelsQuery.data?.labels ?? [];

  async function confirmDelete(label: LabelSummary) {
    setDeleteError(null);
    try {
      await deleteLabel({ variables: { id: label.id } });
    } catch (cause) {
      setDeleteError(describeError(cause));
    }
  }

  return (
    <Section
      surface="card"
      titleClassName={CARD_TITLE}
      title="Labels"
      description="Attach them to projects and todos alike."
      actionSlot={
        <Button
          variant="positive"
          size="sm"
          onPress={() => {
            setEditing(undefined);
            setFormOpen(true);
          }}
          iconSlot={<Plus className="h-4 w-4" />}
          content="New label"
        />
      }
      contentSlot={
        <View className="gap-4">
          {/* Kept outside the dialog: the dialog closes on the failure, and an
          error that vanishes with the thing that caused it was never read. */}
          {deleteError ? (
            <Text className="text-negative text-sm" aria-live="polite">
              {deleteError}
            </Text>
          ) : null}

          <LoadState
            query={labelsQuery}
            what="your labels"
            count={labels.length}
            emptySlot={
              <EmptyState
                iconSlot={<Tag />}
                title="No labels yet."
                description="Labels mark projects and todos, and filter them."
              />
            }
          />
          <List
            divided={false}
            contentSlot={labels.map((label) => (
              <View
                key={label.id}
                className="group flex-row items-center gap-3 rounded-lg border border-foreground/10 bg-secondary px-3 py-2"
              >
                <ColorDot color={label.color} />
                <Text numberOfLines={1} className="flex-1 text-foreground text-sm">
                  {label.name}
                </Text>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={cn('focus-visible:opacity-100', HOVER_REVEAL)}
                  aria-label={`Rename ${label.name}`}
                  onPress={() => {
                    setEditing(label);
                    setFormOpen(true);
                  }}
                  iconSlot={<Pencil className="h-4 w-4" />}
                />
                <ConfirmButton
                  variant="ghost"
                  size="icon-sm"
                  className={cn('hover:text-negative focus-visible:opacity-100', HOVER_REVEAL)}
                  aria-label={`Delete ${label.name}`}
                  title={`Delete “${label.name}”?`}
                  description="It is removed from every project and todo it is attached to. Nothing else is deleted."
                  onConfirm={() => confirmDelete(label)}
                  iconSlot={<Trash2 className="h-4 w-4" />}
                />
              </View>
            ))}
          />

          <LabelFormDialog open={formOpen} onOpenChange={setFormOpen} label={editing} />
        </View>
      }
    />
  );
}
