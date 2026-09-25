import { useQuery } from '@apollo/client';
import { AiStateDocument } from '@/lib/graphql';

/**
 * Whether AI is on, as the app decides what to draw.
 *
 * Two switches, both off unless someone turned them on:
 * - `instance`: the instance's, which an admin flips in Settings. Off, no AI
 *   surface is drawn and no AI document is sent — not even the account's
 *   switch. Only an admin sees the instance's own switch, and only while the
 *   server offers AI at all (`available`; AI_ENABLED is not false).
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
  const available = data?.authConfig.aiAvailable ?? false;
  const instance = data?.authConfig.ai ?? false;
  const account = instance && (data?.users[0]?.aiEnabled ?? false);
  const admin = data?.users[0]?.isAdmin ?? false;
  return { available, instance, admin, account, on: instance && account, userId: data?.users[0]?.id };
}
