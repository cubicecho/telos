import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '@/lib/utils';
import type { DragBoardProps, DraggableCardProps, DropLaneProps } from './drag-surfaces-base';

/*
  The board's drag surfaces, on web: @dnd-kit, on real DOM elements.

  dnd-kit wants an HTMLElement from `setNodeRef`, a CSS transform string on
  `style`, and pointer/keyboard listeners on the node. A react-native-web `View`
  may well satisfy all three, but only by accident of how it forwards props and
  refs today — so the three wrappers that touch dnd-kit are plain `<div>`s, and
  everything inside them (the cards, the column chrome) stays React Native.
  `drag-surfaces.tsx` is the device half: the same wrappers with no drag, which
  leaves the menu routes ("Move to", the lane menu) as the way to move things.
*/

export function DragBoard({ onDragStart, onDrop, onDragCancel, overlay, children }: DragBoardProps) {
  const sensors = useSensors(
    // A few pixels of travel before a drag starts, so the buttons on a card
    // stay clickable and a stray press does not pick the card up.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={({ active }) => onDragStart(String(active.id))}
      onDragEnd={({ active, over }) => {
        if (!over) {
          onDragCancel();
          return;
        }
        onDrop({
          activeId: String(active.id),
          overId: String(over.id),
          // Over a card, the sortable context it belongs to names the column,
          // which is also the only thing that survives a card being dragged out
          // from under the pointer.
          overLaneId: over.data.current?.sortable?.containerId as string | undefined,
        });
      }}
      onDragCancel={onDragCancel}
    >
      {children}
      {/* The card follows the pointer at full opacity while its original stays
          faded in place — picking something up should look like holding it. */}
      <DragOverlay>{overlay}</DragOverlay>
    </DndContext>
  );
}

export function DropLane({ laneId, itemIds, className, overClassName, children }: DropLaneProps) {
  const { setNodeRef, isOver } = useDroppable({ id: laneId, data: { laneId } });
  return (
    <div ref={setNodeRef} className={cn('flex flex-col', className, isOver && overClassName)}>
      <SortableContext id={laneId} items={[...itemIds]} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </div>
  );
}

export function DraggableCard({ id, laneId, locked, children }: DraggableCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    data: { laneId },
    disabled: { draggable: locked, droppable: false },
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      // The original stays in place while it is dragged, faded, so the column
      // does not collapse and reflow under the card being moved.
      className={cn('flex touch-none flex-col', !locked && 'cursor-grab', isDragging && 'opacity-40')}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
}
