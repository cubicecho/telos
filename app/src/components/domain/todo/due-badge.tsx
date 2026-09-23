import { Text, View } from 'react-native';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
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
 * The tooltip carries the full date, because the visible text is relative and
 * "In 5 days" is not something a reader can check against a calendar. A tooltip
 * rather than the `title` attribute this used to be: react-native-web does not
 * forward `title`, and a `View` has nothing else to hang one on.
 */
export function DueBadge({ dueAt, done, className }: { dueAt: string | null; done: boolean; className?: string }) {
  const text = formatDueDate(dueAt);
  if (!text) return null;
  const late = !done && isOverdue(dueAt);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <View
            className={cn(
              'shrink-0 flex-row items-center rounded-full border px-2 py-0.5',
              late ? 'border-destructive/40' : 'border-border',
              className,
            )}
          >
            <Text
              className={cn(
                'font-medium text-[11px] leading-4',
                late ? 'text-destructive' : 'text-muted-foreground',
                done && 'text-muted-foreground',
              )}
            >
              {/* Said in the text as well as in the colour, so a reader who
                  cannot distinguish the red is still told. Prefixed rather than
                  folded into the phrase, because the text is sometimes relative
                  ("Yesterday") and sometimes an absolute date ("Sep 3"), and only
                  a prefix reads as English for both. */}
              {late ? `Overdue · ${text}` : text}
            </Text>
          </View>
        </TooltipTrigger>
        <TooltipContent>{formatDueDateLong(dueAt)}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
