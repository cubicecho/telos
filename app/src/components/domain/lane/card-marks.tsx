import { Text, View } from 'react-native';
import type { CardMarksQuery } from '@/__generated__/graphql';
import { MessageSquare } from '@/components/app-icons';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';

/** What one card has to show, as `cardMarks` answers it. */
export type CardMark = CardMarksQuery['cardMarks'][number];

/** `lastRun` when a reviewer judged the work and sent it back. */
const REJECTED = 'rejected';
/** `lastRun` when the run never finished. */
const ERRORED = 'errored';

/** What each kind of last run is called on the card, and what its reason is a reason for. */
const LAST_RUN = {
  [REJECTED]: {
    label: 'Sent back',
    title: 'A reviewer sent it back',
    missing: 'The reviewer gave no reason.',
  },
  [ERRORED]: {
    label: 'Run failed',
    title: 'The last run did not finish',
    missing: 'The run left no error.',
  },
} as const;

/**
 * The marks for a board, by todo id.
 *
 * @param marks - What `cardMarks` returned, or undefined before it has.
 * @returns A map the cards read their own mark from.
 */
export function marksByTodo(marks: readonly CardMark[] | undefined): ReadonlyMap<string, CardMark> {
  return new Map((marks ?? []).map((mark) => [mark.todoId, mark]));
}

/**
 * How many attempts a station has used, in words.
 *
 * @param mark - The card's mark.
 * @returns The line, or null when no attempt has failed.
 */
export function attemptsText(mark: CardMark): string | null {
  if (mark.attempts === 0) {
    return null;
  }
  const failed = mark.attempts === 1 ? '1 failed attempt' : `${mark.attempts} failed attempts`;
  // "Limit", not "of": a station gives up once the failures pass the limit, so the count can exceed it.
  return mark.maxAttempts == null ? failed : `${failed}, limit ${mark.maxAttempts}`;
}

/**
 * What a card says at a glance about its thread and its last run: that it has
 * notes, that a reviewer sent it back or its run failed (the reason one tap
 * away), and how many attempts are used. Every mark is text or carries a label,
 * so none of it rests on colour.
 */
export function CardMarks({ mark, todoTitle }: { mark: CardMark; todoTitle: string }) {
  const lastRun = mark.lastRun === REJECTED || mark.lastRun === ERRORED ? LAST_RUN[mark.lastRun] : null;
  const attempts = attemptsText(mark);
  const notes = mark.notes === 1 ? '1 note' : `${mark.notes} notes`;

  return (
    <View className="mt-2 flex-row flex-wrap items-center gap-x-2 gap-y-1">
      {mark.notes > 0 ? (
        <View role="img" aria-label={notes} className="flex-row items-center gap-1">
          <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
          <Text aria-hidden className="text-muted-foreground text-xs tabular-nums">
            {mark.notes}
          </Text>
        </View>
      ) : null}

      {lastRun ? (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="xs"
              className={
                mark.lastRun === REJECTED
                  ? 'border-amber-600/60 text-amber-700 dark:text-amber-400'
                  : 'border-destructive/60 text-destructive'
              }
              aria-label={`${lastRun.label}: why “${todoTitle}” came back`}
            >
              {lastRun.label}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72">
            <PopoverHeader>
              <PopoverTitle>{lastRun.title}</PopoverTitle>
              <PopoverDescription>{mark.reason ?? lastRun.missing}</PopoverDescription>
            </PopoverHeader>
          </PopoverContent>
        </Popover>
      ) : null}

      {attempts ? <Text className="text-muted-foreground text-xs">{attempts}</Text> : null}
    </View>
  );
}
