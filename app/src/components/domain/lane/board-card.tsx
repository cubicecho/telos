import { Pressable, Text, View } from 'react-native';
import { AiIgnoredBadge } from '@/components/domain/ai/ai-ignored-badge';
import { LabelBadge } from '@/components/domain/label/label-badge';
import { DueBadge } from '@/components/domain/todo/due-badge';
import type { TodoSummary } from '@/components/domain/todo/types';
import { laneLock } from '@/lib/lanes';
import { cn, HOVER_REVEAL } from '@/lib/utils';
import { DraggableCard } from './drag-surfaces';
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
  onEdit,
  className,
}: {
  todo: TodoSummary;
  lanes: readonly LaneSummary[];
  onMove?: (lane: LaneSummary) => void;
  onEdit?: () => void;
  className?: string;
}) {
  const done = todo.completedAt != null;
  const locked = laneLock(todo);
  const titleClass = cn('text-foreground text-sm leading-5', done && 'text-muted-foreground line-through');

  return (
    <View
      className={cn(
        'group rounded-lg border border-border bg-card px-3 py-2.5 shadow-sm',
        todo.isBlocked && !done && 'opacity-70',
        className,
      )}
    >
      <View className="flex-row items-start gap-2">
        {/* A button on the board too, so both views open a todo the same way.
            Safe inside the draggable because the pointer sensor waits for five
            pixels of travel — a click that does not move is a click. The drag
            overlay passes no handler and so renders plain text, which is right:
            a card in flight is not something to click. */}
        {onEdit ? (
          <Pressable
            role="button"
            onPress={onEdit}
            className="min-w-0 flex-1 rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          >
            <Text className={cn(titleClass, 'hover:underline')}>{todo.title}</Text>
          </Pressable>
        ) : (
          <Text className={cn('min-w-0 flex-1', titleClass)}>{todo.title}</Text>
        )}
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
            size="icon-xs"
            className={cn('-mr-1 -mt-1 focus-visible:opacity-100', HOVER_REVEAL)}
          />
        ) : null}
      </View>

      {todo.dueAt || todo.notes ? (
        <View className="mt-1.5 min-w-0 flex-row items-center gap-2">
          <DueBadge dueAt={todo.dueAt} done={done} />
          {todo.notes ? (
            <Text numberOfLines={1} className="min-w-0 shrink text-muted-foreground text-xs">
              {todo.notes}
            </Text>
          ) : null}
        </View>
      ) : null}

      {todo.isBlocked && !done ? (
        <Text className="mt-1 text-muted-foreground text-xs">
          Blocked by {todo.blockedBy.map((blocker) => blocker.title).join(', ')}
        </Text>
      ) : null}

      {todo.labels.length > 0 ? (
        <View className="mt-2 flex-row flex-wrap gap-1">
          {todo.labels.map((label) => (
            <LabelBadge key={label.id} label={label} />
          ))}
        </View>
      ) : null}

      <AiIgnoredBadge ignored={todo.aiIgnored} className="mt-2" />
    </View>
  );
}

/** A card in its column, draggable by pointer and by keyboard. */
export function BoardCard({
  todo,
  lanes,
  onMove,
  onEdit,
}: {
  todo: TodoSummary;
  lanes: readonly LaneSummary[];
  onMove: (lane: LaneSummary) => void;
  onEdit: () => void;
}) {
  // A blocked card is not draggable — the same choice the row's checkbox makes,
  // disabling the affordance rather than letting it fail — but it stays a drop
  // target, so the cards around it can still be reordered over it.
  return (
    <DraggableCard id={todo.id} laneId={todo.lane?.id} locked={laneLock(todo) != null}>
      <BoardCardBody todo={todo} lanes={lanes} onMove={onMove} onEdit={onEdit} />
    </DraggableCard>
  );
}
