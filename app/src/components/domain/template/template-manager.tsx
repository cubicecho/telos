import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { ConfirmButton } from '@/components/confirm-button';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { Section } from '@/components/section';
import { Button } from '@/components/ui/button';
import { ChevronDown, Library, Trash2 } from '@/components/ui/icons';
import { LoadState } from '@/components/ui/load-failure';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import { describeError } from '@/lib/errors';
import { BoardTemplatesDocument, CreateBoardTemplateDocument, DeleteBoardTemplateDocument } from '@/lib/graphql';
import { CARD_TITLE } from '@/lib/styles';
import { TEMPLATE_STARTERS, type TemplateStarter } from '@/lib/template-starters';
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
 * The board templates, to add from a starter or delete. One is also made from
 * a project's header ("Save lanes as a template"), and used from "New project".
 */
export function TemplateManager() {
  const templatesQuery = useQuery(BoardTemplatesDocument);
  const [deleteTemplate] = useMutation(DeleteBoardTemplateDocument, { refetchQueries: [BoardTemplatesDocument] });
  const [createTemplate] = useMutation(CreateBoardTemplateDocument, { refetchQueries: [BoardTemplatesDocument] });
  const [actionError, setActionError] = useState<string | null>(null);

  async function addStarter(starter: TemplateStarter) {
    setActionError(null);
    try {
      await createTemplate({ variables: { name: starter.name, lanes: starter.lanes } });
    } catch (cause) {
      setActionError(describeError(cause));
    }
  }

  const templates = templatesQuery.data?.boardTemplates ?? [];

  async function confirmDelete(row: TemplateSummary) {
    setActionError(null);
    try {
      await deleteTemplate({ variables: { id: row.id } });
    } catch (cause) {
      setActionError(describeError(cause));
    }
  }

  return (
    <Section
      surface="card"
      titleClassName={CARD_TITLE}
      title="Board templates"
      description="Lanes to start a new project with. Save one from a project's header, or add a starter."
      actionSlot={
        <Menu>
          <MenuTrigger asChild>
            <Button variant="outline" size="sm" content="Add a starter" trailingSlot={<ChevronDown />} />
          </MenuTrigger>
          <MenuContent align="end" aria-label="Template starters">
            {TEMPLATE_STARTERS.map((starter) => (
              <MenuItem key={starter.id} label={starter.name} onSelect={() => addStarter(starter)} />
            ))}
          </MenuContent>
        </Menu>
      }
      contentSlot={
        <View className="gap-4">
          {actionError ? (
            <Text className="text-negative text-sm" aria-live="polite">
              {actionError}
            </Text>
          ) : null}

          <LoadState
            query={templatesQuery}
            what="your templates"
            count={templates.length}
            emptySlot={
              <EmptyState
                iconSlot={<Library />}
                title="No templates yet."
                description="Save one from a project's header, and its lanes can start the next project."
              />
            }
          />
          <List
            divided={false}
            contentSlot={templates.map((template) => (
              <View
                key={template.id}
                className="group flex-row items-center gap-3 rounded-lg border border-foreground/10 bg-secondary px-3 py-2"
              >
                <View className="min-w-0 flex-1">
                  <Text numberOfLines={1} className="text-foreground text-sm">
                    {template.name}
                  </Text>
                  <Text numberOfLines={1} className="text-foreground/60 text-xs">
                    {laneNames(template.lanes)}
                  </Text>
                </View>
                <ConfirmButton
                  variant="ghost"
                  size="icon-sm"
                  className={cn('hover:text-negative focus-visible:opacity-100', HOVER_REVEAL)}
                  aria-label={`Delete ${template.name}`}
                  title={`Delete “${template.name}”?`}
                  description="Projects already made from it keep their lanes."
                  confirmLabel="Delete"
                  onConfirm={() => confirmDelete(template)}
                  iconSlot={<Trash2 className="h-4 w-4" />}
                />
              </View>
            ))}
          />
        </View>
      }
    />
  );
}
