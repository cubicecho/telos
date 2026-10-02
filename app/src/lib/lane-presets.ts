// Lane presets: a station's contract, prompt and limits, kept on the account so
// many lanes can follow one. A lane that follows a preset has the preset's
// contract, WIP limit and attempts unless it overrides them, and adds its own
// prompt after the preset's. The server keeps the lane's columns so; what is
// here is how the forms read and say it.

/** What a lane's agent can be asked for, as a select offers them. */
export const CONTRACTS = [
  { value: 'work', label: 'Work — do the job, then move it on' },
  { value: 'verdict', label: 'Verdict — judge it: pass or fail' },
  { value: 'expand', label: 'Expand — break it into new todos' },
] as const;

/** The fields of a preset a lane may keep its own value for. The prompt is not one: a lane adds to it. */
export const PRESET_FIELDS = ['contract', 'wipLimit', 'maxAttempts'] as const;
export type PresetField = (typeof PRESET_FIELDS)[number];

/** What each field is called where a person reads it. */
export const PRESET_FIELD_LABELS: Record<PresetField, string> = {
  contract: 'contract',
  wipLimit: 'WIP limit',
  maxAttempts: 'attempts',
};

/** What goes between a preset's prompt and the lane's own. */
const PROMPT_BREAK = '\n\n';

export interface PresetValues {
  contract: string;
  prompt?: string | null | undefined;
  wipLimit: number;
  maxAttempts: number;
}

/**
 * Reads a lane's stored overrides, which arrive as untyped JSON.
 *
 * @param value - The lane's `presetOverrides`.
 * @returns The fields it names, in the order the forms show them.
 */
export function overridesOf(value: unknown): PresetField[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return PRESET_FIELDS.filter((field) => value.includes(field));
}

/**
 * A preset's prompt with a lane's own after it, as a run is told them.
 *
 * @param presetPrompt - The preset's prompt.
 * @param lanePrompt - What the lane adds.
 * @returns The two as one, or an empty string when neither says anything.
 */
export function joinPrompts(presetPrompt: string | null | undefined, lanePrompt: string | null | undefined): string {
  return [presetPrompt, lanePrompt]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part !== '')
    .join(PROMPT_BREAK);
}

/**
 * A preset's value for a field, as a form's text.
 *
 * @param preset - The preset.
 * @param field - Which of its fields.
 * @returns What the form holds for it.
 */
export function presetValue(preset: PresetValues, field: PresetField): string {
  return String(preset[field]);
}

/**
 * A preset's value for a field, as a person reads it.
 *
 * @param preset - The preset.
 * @param field - Which of its fields.
 * @returns The contract's name, or the number.
 */
export function describePresetValue(preset: PresetValues, field: PresetField): string {
  if (field !== 'contract') {
    return String(preset[field]);
  }
  return CONTRACTS.find((contract) => contract.value === preset.contract)?.label ?? preset.contract;
}

/**
 * "Overrides contract and WIP limit", for a lane in a preset's list.
 *
 * @param overrides - The lane's `presetOverrides`.
 * @returns The sentence, or one saying it follows the preset as it is.
 */
export function describeOverrides(overrides: unknown): string {
  const names = overridesOf(overrides).map((field) => PRESET_FIELD_LABELS[field]);
  if (names.length === 0) {
    return 'Follows it as it is';
  }
  const last = names.at(-1);
  return `Overrides ${names.length === 1 ? last : `${names.slice(0, -1).join(', ')} and ${last}`}`;
}
