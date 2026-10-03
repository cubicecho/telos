import { type LayerDraft, numberRule } from '@/lib/agents';

// The numeric settings an agent and the account's defaults share, laid out the
// same in both forms. Each is blank to inherit, and its placeholder says what
// the blank stands for.

type NumberField = Exclude<keyof LayerDraft, 'baseUrl' | 'model' | 'toolDiscovery' | 'toolSelectModel'>;

export const NUMBER_FIELDS: ReadonlyArray<{
  name: NumberField;
  label: string;
  inputMode: 'decimal' | 'numeric';
  rule: ReturnType<typeof numberRule>;
}> = [
  {
    name: 'temperature',
    label: 'Temperature',
    inputMode: 'decimal',
    rule: numberRule({ min: 0, max: 2, integer: false }),
  },
  { name: 'maxTokens', label: 'Max tokens', inputMode: 'numeric', rule: numberRule({ min: 0 }) },
  { name: 'contextLength', label: 'Context length', inputMode: 'numeric', rule: numberRule({ min: 0 }) },
  { name: 'maxToolIterations', label: 'Max tool iterations', inputMode: 'numeric', rule: numberRule({ min: 1 }) },
  {
    name: 'requestTimeoutSeconds',
    label: 'Request timeout (seconds)',
    inputMode: 'numeric',
    rule: numberRule({ min: 1 }),
  },
  { name: 'maxRetries', label: 'Max retries', inputMode: 'numeric', rule: numberRule({ min: 0 }) },
];

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
