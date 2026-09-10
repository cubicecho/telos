import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import * as Popover from '@radix-ui/react-popover';
import { Check, CheckCircle2, ChevronLeft, ChevronRight, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import type { TodoSummary } from '@/components/domain/todo/types';
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
import { Input } from '@/components/ui/input';
import type { CachedLane } from '@/lib/cache';
import { cn } from '@/lib/utils';
import { BoardCard } from './board-card';
import type { LaneSummary } from './lane-badge';

/** One action in the lane's menu — a row of the popover, not a button of its own. */
function MenuItem({
  onSelect,
  children,
  destructive,
  disabled,
}: {
  onSelect: () => void;
  children: React.ReactNode;
  destructive?: boolean;
  disabled?: boolean;
}) {
  return (
    <Popover.Close asChild>
      <button
        type="button"
        disabled={disabled}
        onClick={onSelect}
        className={cn(
          'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50',
          destructive && 'text-destructive',
        )}
      >
        {children}
      </button>
    </Popover.Close>
  );
}

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
  onRename,
  onReorder,
  onToggleDone,
  onDelete,
}: {
  lane: CachedLane;
  lanes: readonly CachedLane[];
  todos: readonly TodoSummary[];
  onMove: (todo: TodoSummary, lane: LaneSummary) => void;
  onRename: (name: string) => void;
  onReorder: (delta: number) => void;
  onToggleDone: () => void;
  onDelete: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: lane.id, data: { laneId: lane.id } });
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(lane.name);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const index = lanes.findIndex((row) => row.id === lane.id);

  function submitName(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    setRenaming(false);
    if (trimmed === '' || trimmed === lane.name) {
      setName(lane.name);
      return;
    }
    onRename(trimmed);
  }

  return (
    <section className="flex w-72 shrink-0 flex-col gap-2" aria-label={lane.name}>
      <header className="flex h-8 items-center gap-2 px-1">
        {renaming ? (
          <form onSubmit={submitName} className="flex-1">
            <Input
              autoFocus
              value={name}
              aria-label={`Rename ${lane.name}`}
              className="h-7 text-sm"
              onChange={(event) => setName(event.target.value)}
              onBlur={submitName}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                setName(lane.name);
                setRenaming(false);
              }}
            />
          </form>
        ) : (
          <>
            {lane.isDone ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="Marks work done" />
            ) : null}
            <h3 className="min-w-0 flex-1 truncate font-medium text-sm">{lane.name}</h3>
            <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{todos.length}</span>
          </>
        )}

        <Popover.Root>
          <Popover.Trigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              aria-label={`${lane.name} lane actions`}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              sideOffset={6}
              align="end"
              className="z-50 w-56 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
            >
              <MenuItem onSelect={() => setRenaming(true)}>
                <Pencil className="h-3.5 w-3.5" />
                Rename
              </MenuItem>
              <MenuItem onSelect={onToggleDone}>
                <Check className={cn('h-3.5 w-3.5', !lane.isDone && 'opacity-0')} />
                Marks work done
              </MenuItem>
              <MenuItem onSelect={() => onReorder(-1)} disabled={index <= 0}>
                <ChevronLeft className="h-3.5 w-3.5" />
                Move left
              </MenuItem>
              <MenuItem onSelect={() => onReorder(1)} disabled={index < 0 || index >= lanes.length - 1}>
                <ChevronRight className="h-3.5 w-3.5" />
                Move right
              </MenuItem>
              {/* The last lane has nowhere to send its todos, and a project
                  without a board is a project whose Board tab is empty. */}
              <MenuItem onSelect={() => setConfirmingDelete(true)} destructive disabled={lanes.length <= 1}>
                <Trash2 className="h-3.5 w-3.5" />
                Delete lane
              </MenuItem>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </header>

      <div
        ref={setNodeRef}
        className={cn(
          'flex min-h-32 flex-1 flex-col gap-2 rounded-lg bg-muted/40 p-2 transition-colors',
          isOver && 'bg-muted',
        )}
      >
        <SortableContext id={lane.id} items={todos.map((todo) => todo.id)} strategy={verticalListSortingStrategy}>
          {todos.map((todo) => (
            <BoardCard key={todo.id} todo={todo} lanes={lanes} onMove={(target) => onMove(todo, target)} />
          ))}
        </SortableContext>
        {todos.length === 0 ? <p className="px-1 py-2 text-muted-foreground text-xs">Drop a todo here.</p> : null}
      </div>

      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{lane.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The column goes away. The {todos.length === 1 ? 'todo' : 'todos'} in it{' '}
              {todos.length === 1 ? 'is' : 'are'} kept and moved to the column their completion implies.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={onDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
