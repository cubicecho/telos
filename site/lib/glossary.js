// The site's glossary, read from the domain model's Glossary section.
//
// `.agents/domain-model.md` is the one place telos's words are defined; the
// glossary page is built from it so the two cannot drift. Each entry there is
// `- **Term (alias):** definition. Owner: where it lives in the code.` — the
// page keeps the definition and drops everything from `Owner:` on. The
// Internals group is for people working on telos and is left out.

const SECTION = '## Glossary';
const INTERNAL = 'Internals';

/**
 * @typedef {{ id: string, term: string, aliases: string[], definition: string, html: string }} Entry
 * @typedef {{ id: string, title: string, entries: Entry[] }} Group
 */

/**
 * The public groups of the domain model's glossary, in order.
 *
 * @param {string} markdown The whole of `.agents/domain-model.md`.
 * @returns {Group[]} Each group with its entries, the Internals group left out.
 */
export function parseGlossary(markdown) {
  const start = markdown.indexOf(`\n${SECTION}\n`);
  if (start === -1) throw new Error(`The domain model has no "${SECTION}" section.`);
  const rest = markdown.slice(start + SECTION.length + 2);
  const end = rest.search(/^## /m);
  const lines = (end === -1 ? rest : rest.slice(0, end)).split('\n');

  /** @type {Group[]} */
  const groups = [];
  /** @type {string[] | null} */
  let item = null;
  const flush = () => {
    const group = groups.at(-1);
    if (item && group) group.entries.push(entryOf(item.join(' ')));
    item = null;
  };

  for (const line of lines) {
    if (line.startsWith('### ')) {
      flush();
      const title = line.slice(4).trim();
      groups.push({ id: slug(title), title, entries: [] });
    } else if (line.startsWith('- ')) {
      flush();
      item = [line.slice(2).trim()];
    } else if (item && line.startsWith('  ') && line.trim()) {
      item.push(line.trim());
    } else {
      flush();
    }
  }
  flush();

  return groups.filter((group) => group.title !== INTERNAL);
}

/**
 * One entry, its definition cut at `Owner:`.
 *
 * @param {string} text The entry's text, its lines joined.
 * @returns {Entry} The entry.
 */
function entryOf(text) {
  const match = /^\*\*(.+?):\*\*\s*(.*)$/.exec(text);
  if (!match) throw new Error(`A glossary entry does not open with "**Term:**": ${text}`);
  const [, name, body] = match;
  const aliased = /^(.+?)\s*\((.+)\)$/.exec(name);
  const term = aliased ? aliased[1] : name;
  const aliases = aliased ? aliased[2].split(',').map((alias) => alias.trim()) : [];
  // In the model a definition follows a colon; on the page it starts a sentence.
  const cut = body.split(/\s*Owner:/)[0].trim();
  const definition = cut.charAt(0).toUpperCase() + cut.slice(1);
  return { id: slug(term), term, aliases, definition, html: inline(definition) };
}

/**
 * The little markdown a definition uses: bold and code, escaped first.
 *
 * @param {string} text Markdown.
 * @returns {string} HTML.
 */
function inline(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

/**
 * An anchor for a heading or term.
 *
 * @param {string} text The heading or term.
 * @returns {string} Lowercase words joined by hyphens.
 */
function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
