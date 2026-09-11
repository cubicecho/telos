import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { useState } from 'react';
import { TodoFormDialog } from '@/components/domain/todo/todo-form-dialog';
import type { TodoSummary } from '@/components/domain/todo/types';
import type { CachedLane } from '@/lib/cache';
import { describeError } from '@/lib/errors';
import { todosInLane } from '@/lib/lanes';
import { BoardCardBody } from './board-card';
import type { LaneSummary } from './lane-badge';
import { LaneColumn } from './lane-column';
import { LaneComposer } from './lane-composer';
import { useLaneActions } from './use-lane-actions';
import { useMoveTodo } from './use-move-todo';

/**
 * The project's todos as columns.
 *
 * The board shows the same rows as the list and changes them the same way —
 * `position` is project-wide and completion follows the done lane — so the two
 * tabs are two drawings of one list rather than two states to keep in step.
 *
 * Dragging is the obvious gesture and reaches only a pointer, so every move it
 * offers is also a menu item: each card carries "Move to", each column header
 * carries its own actions.
 */
export function Board({
  projectId,
  lanes,
  todos,
}: {
  projectId: string;
  lanes: readonly CachedLane[];
  todos: readonly TodoSummary[];
}) {
  const [dragging, setDragging] = useState<TodoSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One dialog for the whole board rather than one per card: it is modal, so
  // only ever one can be open, and mounting dozens would cost a Radix portal
  // each for a surface nobody has asked for yet.
  const [editing, setEditing] = useState<TodoSummary | null>(null);

  const actions = useLaneActions(projectId);
  const moveTodo = useMoveTodo(projectId);

  const sensors = useSensors(
    // A few pixels of travel before a drag starts, so the buttons on a card
    // stay clickable and a stray press does not pick the card up.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Returns the promise so a caller that awaits — LaneComposer does — is
  // awaiting something that cannot reject. Every lane action goes through
  // here; one that does not is a silent failure by construction.
  function run(action: () => Promise<unknown>): Promise<void> {
    setError(null);
    return action().then(
      () => undefined,
      (reason) => setError(describeError(reason)),
    );
  }

  function onDragStart({ active }: DragStartEvent) {
    setDragging(todos.find((todo) => todo.id === active.id) ?? null);
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    setDragging(null);
    if (!over) return;

    const todo = todos.find((row) => row.id === active.id);
    if (!todo) return;

    // A drop lands either on a column or on a card in one. Over a card, the
    // sortable context it belongs to names the column, which is also the only
    // thing that survives a card being dragged out from under the pointer.
    const onColumn = lanes.find((row) => row.id === over.id);
    const laneId = onColumn?.id ?? (over.data.current?.sortable?.containerId as string | undefined);
    const lane = lanes.find((row) => row.id === laneId);
    if (!lane) return;

    const inLane = todosInLane(todos, lane.id);
    const at = onColumn ? -1 : inLane.findIndex((row) => row.id === over.id);
    run(() => moveTodo(todo, lane, at < 0 ? inLane.length : at));
  }

  function move(todo: TodoSummary, lane: LaneSummary) {
    const target = lanes.find((row) => row.id === lane.id);
    if (target) run(() => moveTodo(todo, target));
  }

  return (
    <div className="flex flex-col gap-2">
      {error ? (
        <p className="text-destructive text-sm" aria-live="polite">
          {error}
        </p>
      ) : null}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragging(null)}
      >
        <div className="flex items-start gap-3 overflow-x-auto pb-2">
          {lanes.map((lane) => (
            <LaneColumn
              key={lane.id}
              lane={lane}
              lanes={lanes}
              todos={todosInLane(todos, lane.id)}
              onMove={move}
              onEdit={setEditing}
              onRename={(name) => run(() => actions.renameLane(lane, name))}
              onReorder={(delta) => run(() => actions.moveLane(lanes, lane, delta))}
              onToggleDone={() => run(() => actions.toggleDoneLane(lane))}
              onDelete={() => run(() => actions.deleteLane(lane))}
            />
          ))}
          <LaneComposer onCreate={(name) => run(() => actions.createLane(name, lanes.length))} />
        </div>

        {/* The card follows the pointer at full opacity while its original stays
            faded in place — picking something up should look like holding it. */}
        <DragOverlay>{dragging ? <BoardCardBody todo={dragging} lanes={lanes} /> : null}</DragOverlay>
      </DndContext>

      {/* Todos with no lane at all only happen between a lane being deleted and
          the refetch that rehomes them, but saying so beats them vanishing. */}
      {todos.some((todo) => todo.lane == null) ? (
        <p className="text-muted-foreground text-xs">Some todos are not in a lane yet. Reload to place them.</p>
      ) : null}

      {/* Keyed by id so reopening on a different card resets the form, and
          unmounted while closed so a stale todo cannot be edited after the
          board has moved on from it. */}
      {editing ? (
        <TodoFormDialog key={editing.id} open onOpenChange={(next) => !next && setEditing(null)} todo={editing} />
      ) : null}
    </div>
  );
}
