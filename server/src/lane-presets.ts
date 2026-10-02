// A lane that follows a preset is told two prompts: the preset's, which every
// lane following it shares, and then its own, which adds to it. The rest of
// what a preset holds is kept on the lane itself by the `lanes_follow_preset`
// trigger, so nothing else reads a preset to run a station.

/** What goes between a preset's prompt and the lane's own. */
const PROMPT_BREAK = '\n\n';

/**
 * A preset's prompt with a lane's own after it.
 *
 * @param presetPrompt The preset's, if the lane follows one and it has one.
 * @param lanePrompt What the lane adds.
 * @returns The two as one prompt, or null when neither says anything.
 */
export function joinPrompts(
  presetPrompt: string | null | undefined,
  lanePrompt: string | null | undefined,
): string | null {
  const parts = [presetPrompt, lanePrompt].map((part) => part?.trim() ?? '').filter((part) => part !== '');
  return parts.length > 0 ? parts.join(PROMPT_BREAK) : null;
}
