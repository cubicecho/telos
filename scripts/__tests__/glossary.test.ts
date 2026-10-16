import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseGlossary } from '../../site/lib/glossary.js';

// The site's glossary page is built from the domain model, so a change to the
// model's format fails here rather than publishing a thin or broken page.
const model = readFileSync(new URL('../../.agents/domain-model.md', import.meta.url), 'utf8');

describe('the glossary the site publishes', () => {
  const groups = parseGlossary(model);
  const entries = groups.flatMap((group) => group.entries);

  it('has the public groups of the domain model, and not its internals', () => {
    expect(groups.map((group) => group.title)).toContain('Places');
    expect(groups.map((group) => group.title)).not.toContain('Internals');
    expect(entries.length).toBeGreaterThan(30);
  });

  it('gives every term a definition that reads without code', () => {
    for (const entry of entries) {
      expect(entry.definition, entry.term).toMatch(/\w{3,}/);
      expect(entry.definition, entry.term).not.toMatch(/`|Owner:/);
    }
  });

  it('gives every term its own anchor', () => {
    const ids = entries.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('cuts the code details off a definition and reads aliases', () => {
    const [group] = parseGlossary(
      '# M\n\n## Glossary\n\nIntro.\n\n### Work\n\n- **Dependency (blocker):** waits on\n  another. Owner: `x.ts`.\n\n### Internals\n\n- **Lease:** held. Owner: `y`.\n\n## Explain test\n',
    );
    expect(group.entries).toEqual([
      {
        id: 'dependency',
        term: 'Dependency',
        aliases: ['blocker'],
        definition: 'Waits on another.',
        html: 'Waits on another.',
      },
    ]);
  });
});
