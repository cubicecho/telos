import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_INSTRUCTIONS, MIGRATED_AGENT_PROMPT, SEEDED_PROMPTS } from '../prompt-seeds.ts';

// The prompts migration seeded the accounts there were then with a copy of
// this text, and the server seeds every account since from the module. The
// two must say the same, or an account's prompts would depend on when it
// signed up. A change to the seed text means a new migration to bring the
// accounts already seeded along, if they should be: this test fails until the
// old one's copy is dealt with on purpose.
const MIGRATION = readFileSync(new URL('../../drizzle/20261023033840_prompts/migration.sql', import.meta.url), 'utf8');

/**
 * The texts between a dollar-quote tag's pairs, in order.
 *
 * @param tag - The tag, without its dollars.
 * @returns What each pair quotes.
 */
function quoted(tag: string): string[] {
  const marker = `$${tag}$`;
  const parts = MIGRATION.split(marker);
  return parts.filter((_part, index) => index % 2 === 1);
}

describe('the seeded prompts', () => {
  it('are the ones the prompts migration seeded', () => {
    expect(quoted('seed')).toEqual(SEEDED_PROMPTS.map((seed) => seed.body));
    for (const seed of SEEDED_PROMPTS) {
      expect(MIGRATION).toContain(`('${seed.name}', $seed$`);
    }
  });

  it('keep the default instructions the migration kept global context under', () => {
    expect(quoted('instructions')).toEqual([DEFAULT_AGENT_INSTRUCTIONS]);
  });

  it('point migrated agents at a prompt that is seeded', () => {
    expect(SEEDED_PROMPTS.map((seed) => seed.name)).toContain(MIGRATED_AGENT_PROMPT);
    expect(MIGRATION).toContain(`p."name" = '${MIGRATED_AGENT_PROMPT}'`);
  });

  it('have names an account can hold all of at once', () => {
    const names = SEEDED_PROMPTS.map((seed) => seed.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
