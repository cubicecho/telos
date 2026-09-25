import { useRef, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import type { StationFieldsFragment } from '@/__generated__/graphql';
import { Ellipsis } from '@/components/app-icons';
import type { TodoSummary } from '@/components/domain/todo/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Check, ChevronLeft, ChevronRight, CircleCheck, Pencil, Settings, Trash2 } from '@/components/ui/icons';
import { INPUT_CLASS } from '@/components/ui/input-base';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import type { CachedLane } from '@/lib/cache';
import { cn } from '@/lib/utils';
import { type BoardAi, BoardCard } from './board-card';
import { DropLane } from './drag-surfaces';
import type { LaneSummary } from './lane-badge';

/**
 * One column of the board: a droppable region and everything the column itself
 * can be told to do.
 *
 * Every action here has a keyboard route — reordering is a menu item rather
 * than a second kind of drag, because a board whose columns can only be
 * rearranged by pointer is a board half the people using it cannot rearrange.
 */
export function LaneColumn({
  lane,
  lanes,
  todos,
  onMove,
  onEdit,
  onRename,
  onReorder,
  onToggleDone,
  onDelete,
  station,
  agentName,
  onEditStation,
  ai,
}: {
  lane: CachedLane;
  lanes: readonly CachedLane[];
  todos: readonly TodoSummary[];
  onMove: (todo: TodoSummary, lane: LaneSummary) => void;
  onEdit: (todo: TodoSummary) => void;
  onRename: (name: string) => void;
  onReorder: (delta: number) => void;
  onToggleDone: () => void;
  onDelete: () => void;
  /**
   * The lane's station settings: `undefined` while AI is off for the project,
   * when a lane cannot be a station and the menu does not offer it.
   */
  station?: StationFieldsFragment | null | undefined;
  agentName?: string | undefined;
  onEditStation?: (() => void) | undefined;
  /** What the project's agents are doing to its cards, while AI is on for it. */
  ai?: BoardAi | undefined;
}) {
  const [renaming, setRenaming] = useState(false);
  const renameInput = useRef<TextInput>(null);
  const [name, setName] = useState(lane.name);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const index = lanes.findIndex((row) => row.id === lane.id);

  function submitName() {
    if (!renaming) return;
    const trimmed = name.trim();
    setRenaming(false);
    if (trimmed === '' || trimmed === lane.name) {
      setName(lane.name);
      return;
    }
    onRename(trimmed);
  }

  return (
    <View role="region" aria-label={lane.name} className="w-72 shrink-0 gap-2">
      <View className="h-8 flex-row items-center gap-2 px-1">
        {renaming ? (
          <TextInput
            ref={renameInput}
            autoFocus
            value={name}
            aria-label={`Rename ${lane.name}`}
            className={cn(INPUT_CLASS, 'h-7 flex-1 py-1')}
            onChangeText={setName}
            onSubmitEditing={submitName}
            onBlur={submitName}
            onKeyPress={(event) => {
              if (event.nativeEvent.key !== 'Escape') return;
              setName(lane.name);
              setRenaming(false);
            }}
          />
        ) : (
          <>
            {lane.isDone ? (
              <CircleCheck className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="Marks work done" />
            ) : null}
            <Text
              role="heading"
              aria-level={3}
              numberOfLines={1}
              className="min-w-0 flex-1 font-medium text-foreground text-sm"
            >
              {lane.name}
            </Text>
            {station?.agentId ? (
              <Badge variant="secondary" aria-label={`Station, worked by ${agentName ?? 'an agent'}`}>
                Station
              </Badge>
            ) : null}
            <Text className="shrink-0 text-muted-foreground text-xs tabular-nums">{todos.length}</Text>
          </>
        )}

        <Menu>
          <MenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label={`${lane.name} lane actions`}>
              <Ellipsis className="h-4 w-4" />
            </Button>
          </MenuTrigger>
          <MenuContent
            align="end"
            className="w-56"
            // Rename hands focus to its input, but the input mounts while the
            // menu still traps focus, and radix gives it to the trigger once the
            // menu unmounts. So the hand-off happens here, at the moment radix
            // would return it. Web-only radix prop, so it goes past the shared
            // types. Local patch until cubicecho/cubeui#119.
            {...({
              onCloseAutoFocus: (event: Event) => {
                if (!renameInput.current) return;
                event.preventDefault();
                renameInput.current.focus();
              },
            } as object)}
          >
            <MenuItem label="Rename" icon={<Pencil className="h-3.5 w-3.5" />} onSelect={() => setRenaming(true)} />
            <MenuItem
              label="Marks work done"
              icon={<Check className={cn('h-3.5 w-3.5', !lane.isDone && 'opacity-0')} />}
              onSelect={onToggleDone}
            />
            {onEditStation ? (
              <MenuItem label="Station…" icon={<Settings className="h-3.5 w-3.5" />} onSelect={onEditStation} />
            ) : null}
            <MenuItem
              label="Move left"
              icon={<ChevronLeft className="h-3.5 w-3.5" />}
              disabled={index <= 0}
              onSelect={() => onReorder(-1)}
            />
            <MenuItem
              label="Move right"
              icon={<ChevronRight className="h-3.5 w-3.5" />}
              disabled={index < 0 || index >= lanes.length - 1}
              onSelect={() => onReorder(1)}
            />
            {/* The last lane has nowhere to send its todos, and a project
                without a board is a project whose Board tab is empty. */}
            <MenuItem
              label="Delete lane"
              icon={<Trash2 className="h-3.5 w-3.5" />}
              destructive
              disabled={lanes.length <= 1}
              onSelect={() => setConfirmingDelete(true)}
            />
          </MenuContent>
        </Menu>
      </View>

      <DropLane
        laneId={lane.id}
        itemIds={todos.map((todo) => todo.id)}
        className="min-h-32 flex-1 gap-2 rounded-lg bg-muted/40 p-2 transition-colors"
        overClassName="bg-muted"
      >
        {todos.map((todo) => (
          <BoardCard
            key={todo.id}
            todo={todo}
            lanes={lanes}
            onMove={(target) => onMove(todo, target)}
            onEdit={() => onEdit(todo)}
            live={ai?.live.get(todo.id)}
            stuck={ai?.stuck.get(todo.id)}
            onWatch={ai ? () => ai.onWatch(todo) : undefined}
            onRetry={ai ? () => ai.onRetry(todo) : undefined}
          />
        ))}
        {todos.length === 0 ? <Text className="px-1 py-2 text-muted-foreground text-xs">Drop a todo here.</Text> : null}
      </DropLane>

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={`Delete “${lane.name}”?`}
        description={`The column goes away. The ${todos.length === 1 ? 'todo' : 'todos'} in it ${
          todos.length === 1 ? 'is' : 'are'
        } kept and moved to the column their completion implies.`}
        confirmLabel="Delete"
        onConfirm={() => {
          setConfirmingDelete(false);
          onDelete();
        }}
      />
    </View>
  );
}
