import { useApolloClient, useSubscription } from '@apollo/client';
import { useEffect, useRef } from 'react';
import { BoardChangedDocument } from '@/lib/graphql';

/** How long a burst of changes settles before the screen refetches once. */
export const BOARD_SETTLE_MS = 300;

/**
 * Keeps what is on screen current while someone else changes the board: an
 * agent working its lanes, an MCP client adding a request, another tab.
 *
 * The server says only that the project changed, and in which table, so this
 * refetches the active queries through the scopes they already have; a burst
 * (a run finishing moves a todo and writes a note) settles into one refetch.
 *
 * @param projectId The project on screen, or undefined to watch nothing.
 */
export function useBoardUpdates(projectId: string | undefined, settleMs = BOARD_SETTLE_MS): void {
  const client = useApolloClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useSubscription(BoardChangedDocument, {
    variables: { projectId: projectId ?? '' },
    skip: !projectId,
    onData: () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        void client.refetchQueries({ include: 'active' });
      }, settleMs);
    },
  });

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
}
