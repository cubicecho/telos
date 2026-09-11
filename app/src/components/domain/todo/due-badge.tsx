import { formatDueDate, formatDueDateLong, isOverdue } from '@/lib/dates';
import { cn } from '@/lib/utils';

/**
 * When a todo is due, in as few characters as say it.
 *
 * Shaped like `LaneBadge` so a row carrying both reads as one line of metadata
 * rather than two competing ones. It goes destructive only while the todo is
 * still open: a late todo that has since been finished is history, and colouring
 * it red forever would make the done list look like a list of failures.
 *
 * The `title` carries the full date, because the visible text is relative and
 * "In 5 days" is not something a reader can check against a calendar.
 */
export function DueBadge({ dueAt, done, className }: { dueAt: string | null; done: boolean; className?: string }) {
  const text = formatDueDate(dueAt);
  if (!text) return null;
  const late = !done && isOverdue(dueAt);

  return (
    <span
      title={formatDueDateLong(dueAt)}
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 font-medium text-[11px] leading-4',
        late ? 'border-destructive/40 text-destructive' : 'text-muted-foreground',
        done && 'text-muted-foreground',
        className,
      )}
    >
      {/* Said in the text as well as in the colour, so a reader who cannot
          distinguish the red is still told. Prefixed rather than folded into
          the phrase, because the text is sometimes relative ("Yesterday") and
          sometimes an absolute date ("Sep 3"), and only a prefix reads as
          English for both. */}
      {late ? `Overdue · ${text}` : text}
    </span>
  );
}
