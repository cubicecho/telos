import type { ReactNode } from 'react';

/**
 * Where a drop landed, in the board's own terms: the card that moved, the thing
 * it was dropped on (a lane or another card), and — when that was a card — the
 * lane that card sits in. The board turns this into a lane and an index.
 */
export type Drop = {
  activeId: string;
  overId: string;
  /** The sortable container the drop target belongs to, when it was a card. */
  overLaneId: string | undefined;
};

export type DragBoardProps = {
  onDragStart: (id: string) => void;
  onDrop: (drop: Drop) => void;
  onDragCancel: () => void;
  /** What follows the pointer while `id` is being dragged. */
  overlay: ReactNode;
  children: ReactNode;
};

export type DropLaneProps = {
  laneId: string;
  /** The card ids in this lane, in order — the sortable context's items. */
  itemIds: readonly string[];
  className?: string | undefined;
  /** Merged over `className` while a card is held over the lane. */
  overClassName?: string | undefined;
  children: ReactNode;
};

export type DraggableCardProps = {
  id: string;
  laneId: string | undefined;
  /** A card that cannot change column is not draggable, but stays a drop target. */
  locked: boolean;
  children: ReactNode;
};
