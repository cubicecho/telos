import { useQuery } from '@apollo/client';
import { AiStateDocument } from '@/lib/graphql';

/**
 * Whether AI is on, as the app decides what to draw.
 *
 * Two switches, both off unless someone turned them on:
 * - `instance`: the server's AI_ENABLED. Off, the AI fields do not exist in its
 *   schema, so no AI surface is drawn and no AI document is ever sent — not even
 *   the account's switch.
 * - `account`: the person's own switch, in Settings. Off, only that switch shows.
 *
 * `on` is both. Anything that is AI's (API keys, a project's switch, the
 * "AI ignores this" chip) is drawn only when it is true. A project's own switch
 * is a third layer, read from the project where it is needed.
 *
 * Until the answer arrives everything reads as off, so an AI surface can appear
 * a moment late but never flashes in front of someone who turned it off.
 */
export function useAi() {
  const { data } = useQuery(AiStateDocument);
  const instance = data?.authConfig.ai ?? false;
  const account = instance && (data?.users[0]?.aiEnabled ?? false);
  return { instance, account, on: instance && account, userId: data?.users[0]?.id };
}
