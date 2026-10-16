// The glossary page's terms, from the domain model (see lib/glossary.js).

import { readFileSync } from 'node:fs';

import { parseGlossary } from '../../lib/glossary.js';

const model = new URL('../../../.agents/domain-model.md', import.meta.url);

export default function () {
  return parseGlossary(readFileSync(model, 'utf8'));
}
