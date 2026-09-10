import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { LabelBadge } from '@/components/domain/label/label-badge';
import type { TodoSummary } from '@/components/domain/todo/types';
import { laneLock } from '@/lib/lanes';
import { cn } from '@/lib/utils';
import type { LaneSummary } from './lane-badge';
import { LanePicker } from './lane-picker';

/**
 * The card itself, without any knowledge of dragging — the board renders this
 * twice, once in place and once inside the drag overlay, and the two have to be
 * the same object or the card would change shape as it is picked up.
 */
export function BoardCardBody({
  todo,
  lanes,
  onMove,
  className,
}: {
  todo: TodoSummary;
  lanes: readonly LaneSummary[];
  onMove?: (lane: LaneSummary) => void;
  className?: string;
}) {
  const done = todo.completedAt != null;
  const locked = laneLock(todo);

  return (
    <div
      className={cn(
        'group rounded-lg border bg-card px-3 py-2.5 shadow-sm',
        todo.isBlocked && !done && 'opacity-70',
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <p className={cn('min-w-0 flex-1 text-sm leading-5', done && 'text-muted-foreground line-through')}>
          {todo.title}
        </p>
        {/* The keyboard's way to do what the pointer does by dragging. Kept in
            the card rather than the column so the two routes name the same
            todo. */}
        {onMove ? (
          <LanePicker
            lanes={lanes}
            current={todo.lane}
            onSelect={onMove}
            lockedReason={locked}
            align="end"
            className="-mr-1 -mt-1 h-7 w-7 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 has-[[data-state=open]]:opacity-100"
          />
        ) : null}
      </div>

      {todo.isBlocked && !done ? (
        <p className="mt-1 text-muted-foreground text-xs">
          Blocked by {todo.blockedBy.map((blocker) => blocker.title).join(', ')}
        </p>
      ) : null}

      {todo.labels.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {todo.labels.map((label) => (
            <LabelBadge key={label.id} label={label} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A card in its column, draggable by pointer and by keyboard. */
export function BoardCard({
  todo,
  lanes,
  onMove,
}: {
  todo: TodoSummary;
  lanes: readonly LaneSummary[];
  onMove: (lane: LaneSummary) => void;
}) {
  // A blocked card is not draggable — the same choice the row's checkbox makes,
  // disabling the affordance rather than letting it fail — but it stays a drop
  // target, so the cards around it can still be reordered over it.
  const locked = laneLock(todo);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: todo.id,
    data: { laneId: todo.lane?.id },
    disabled: { draggable: locked != null, droppable: false },
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      // The original stays in place while it is dragged, faded, so the column
      // does not collapse and reflow under the card being moved.
      className={cn('touch-none', locked == null && 'cursor-grab', isDragging && 'opacity-40')}
      {...attributes}
      {...listeners}
    >
      <BoardCardBody todo={todo} lanes={lanes} onMove={onMove} />
    </div>
  );
}
