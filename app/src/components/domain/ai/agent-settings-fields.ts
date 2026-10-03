import { type LayerDraft, numberRule } from '@/lib/agents';

// The numeric settings an agent and the account's defaults share, laid out the
// same in both forms. Each is blank to inherit, and its placeholder says what
// the blank stands for.

type NumberField = Exclude<
  keyof LayerDraft,
  'baseUrl' | 'model' | 'toolDiscovery' | 'toolSelectModel' | 'reasoningEffort'
>;

/** Which group of a form a number sits in: with the model, the tools, or the requests. */
export type NumberGroup = 'model' | 'tools' | 'requests';

export const NUMBER_FIELDS: ReadonlyArray<{
  name: NumberField;
  label: string;
  group: NumberGroup;
  inputMode: 'decimal' | 'numeric';
  rule: ReturnType<typeof numberRule>;
}> = [
  {
    name: 'temperature',
    label: 'Temperature',
    group: 'model',
    inputMode: 'decimal',
    rule: numberRule({ min: 0, max: 2, integer: false }),
  },
  { name: 'maxTokens', label: 'Max tokens', group: 'model', inputMode: 'numeric', rule: numberRule({ min: 0 }) },
  {
    name: 'contextLength',
    label: 'Context length',
    group: 'model',
    inputMode: 'numeric',
    rule: numberRule({ min: 0 }),
  },
  {
    name: 'maxToolIterations',
    label: 'Max tool iterations',
    group: 'tools',
    inputMode: 'numeric',
    rule: numberRule({ min: 1 }),
  },
  {
    name: 'requestTimeoutSeconds',
    label: 'Request timeout (seconds)',
    group: 'requests',
    inputMode: 'numeric',
    rule: numberRule({ min: 1 }),
  },
  { name: 'maxRetries', label: 'Max retries', group: 'requests', inputMode: 'numeric', rule: numberRule({ min: 0 }) },
];

/** The numbers in one group, in order. */
export const numbersIn = (group: NumberGroup) => NUMBER_FIELDS.filter((spec) => spec.group === group);

/**
 * The choices for tool discovery, the first saying what inheriting it gives.
 *
 * @param inherited - "on" or "off", or blank while it loads.
 * @returns The select's options.
 */
export function discoveryOptions(inherited: string) {
  return [
    { value: 'inherit', label: inherited ? `Inherit (${inherited})` : 'Inherit' },
    { value: 'on', label: 'On' },
    { value: 'off', label: 'Off' },
  ] as const;
}

export const DISCOVERY_HELP =
  'Offer the model only the tools a cheap first pass picks. For servers with more tools than a small context holds.';

/** The levels min-agent offers, in order; agent-core passes any string through. */
const EFFORTS = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * The choices for reasoning effort, the first saying what inheriting it gives.
 *
 * @param inherited - The level a blank resolves to, or blank while it loads.
 * @param current - What is stored, kept as a choice when it is none of the levels.
 * @returns The select's options.
 */
export function effortOptions(inherited: string, current: string) {
  const levels: string[] = [...EFFORTS];
  if (current !== 'inherit' && current.trim() !== '' && !levels.includes(current)) levels.push(current);
  return [
    { value: 'inherit', label: inherited ? `Inherit (${inherited})` : 'Inherit' },
    ...levels.map((level) => ({ value: level, label: level === 'off' ? 'Off: send none' : level })),
  ];
}

export const EFFORT_HELP =
  'How hard a reasoning model thinks before it answers. Off sends nothing, which every endpoint takes; a level the model refuses is stepped down.';
