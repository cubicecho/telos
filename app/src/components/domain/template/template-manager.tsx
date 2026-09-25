import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Section } from '@/components/section';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Trash2 } from '@/components/ui/icons';
import { LoadState } from '@/components/ui/load-failure';
import { describeError } from '@/lib/errors';
import { BoardTemplatesDocument, DeleteBoardTemplateDocument } from '@/lib/graphql';
import { cn, HOVER_REVEAL } from '@/lib/utils';

interface TemplateSummary {
  id: string;
  name: string;
  lanes: unknown;
}

/** "To do, Doing, Done", from a template's stored lanes. */
function laneNames(lanes: unknown): string {
  if (!Array.isArray(lanes)) return '';
  return lanes.map((lane) => (lane && typeof lane === 'object' && 'name' in lane ? String(lane.name) : '?')).join(', ');
}

/**
 * The board templates, to delete. One is made from a project's header ("Save
 * lanes as a template") and used from "New project".
 */
export function TemplateManager() {
  const templatesQuery = useQuery(BoardTemplatesDocument);
  const [deleting, setDeleting] = useState<TemplateSummary | null>(null);
  const [deleteTemplate] = useMutation(DeleteBoardTemplateDocument, { refetchQueries: [BoardTemplatesDocument] });
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const templates = templatesQuery.data?.boardTemplates ?? [];

  async function confirmDelete() {
    setDeleteError(null);
    try {
      if (deleting) await deleteTemplate({ variables: { id: deleting.id } });
    } catch (cause) {
      setDeleteError(describeError(cause));
    }
    setDeleting(null);
  }

  return (
    <Section
      surface="card"
      title="Board templates"
      description="Lanes to start a new project with. Save one from a project's header."
      content={
        <View className="gap-4">
          {deleteError ? (
            <Text className="text-destructive text-sm" aria-live="polite">
              {deleteError}
            </Text>
          ) : null}

          <LoadState
            query={templatesQuery}
            what="your templates"
            count={templates.length}
            empty={<Text className="text-muted-foreground text-sm">No templates yet.</Text>}
          />
          {templates.length === 0 ? null : (
            <View role="list" className="gap-1">
              {templates.map((template) => (
                <View
                  key={template.id}
                  role="listitem"
                  className="group flex-row items-center gap-3 rounded-lg border border-border bg-card px-3 py-2"
                >
                  <View className="min-w-0 flex-1">
                    <Text numberOfLines={1} className="text-foreground text-sm">
                      {template.name}
                    </Text>
                    <Text numberOfLines={1} className="text-muted-foreground text-xs">
                      {laneNames(template.lanes)}
                    </Text>
                  </View>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className={cn('hover:text-destructive focus-visible:opacity-100', HOVER_REVEAL)}
                    aria-label={`Delete ${template.name}`}
                    onPress={() => setDeleting(template)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </View>
              ))}
            </View>
          )}

          <ConfirmDialog
            open={deleting !== null}
            onOpenChange={(open) => !open && setDeleting(null)}
            title={`Delete “${deleting?.name ?? ''}”?`}
            description="Projects already made from it keep their lanes."
            confirmLabel="Delete"
            onConfirm={confirmDelete}
          />
        </View>
      }
    />
  );
}
