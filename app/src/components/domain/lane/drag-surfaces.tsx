import { View } from 'react-native';
import { cn } from '@/lib/utils';
import type { DragBoardProps, DraggableCardProps, DropLaneProps } from './drag-surfaces-base';

/*
  The board's drag surfaces, on device: none. @dnd-kit is DOM-only, and this
  app ships to the web (see `drag-surfaces.web.tsx`, which Metro picks there).
  These are the same wrappers with no drag, so a native build still lays the
  board out and moves cards through the menus every card and column carry.
*/

export function DragBoard({ children }: DragBoardProps) {
  return <>{children}</>;
}

export function DropLane({ className, children }: DropLaneProps) {
  return <View className={cn('flex-col', className)}>{children}</View>;
}

export function DraggableCard({ children }: DraggableCardProps) {
  return <View>{children}</View>;
}
