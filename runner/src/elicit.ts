import type { ElicitRequestParams, ElicitResult } from '@cubicecho/agent-mcp-pool';

// A server asking a person, mid-call: MCP's elicitation. A run has nobody to
// put a form in front of while its call is open, so it takes the ask-a-person
// path instead: the server is answered `cancel`, and what it asked becomes the
// run's question, as though the agent had called `ask_person` with it. Telos
// holds the todo until a person replies, and the next run is shown the
// question and the reply. Pure: nothing here talks to telos or the pool.

/** What every elicitation is answered: nobody is there to fill the form in now. */
export const ELICIT_CANCEL: ElicitResult = { action: 'cancel' };

/** What the agent is told when a call's server asked a person. The run stops right after. */
export const ELICITED_REPLY = 'The server asked a person for input. This run ends here; the todo waits for the answer.';

/** The most of a server's message a question carries; it is the server's text, not the agent's. */
const MESSAGE_CHARS = 2000;

/** The most fields a question lists, so a server cannot fill a thread with a schema. */
const MAX_FIELDS = 20;

/**
 * A field that reads like a credential. The spec forbids asking for one this
 * way, so a server that does is either broken or fishing, and the person is
 * told not to answer it in a thread every later run reads.
 */
const SECRET_LIKE =
  /pass(word|phrase|code)?|secret|token|api[\s_-]?key|access[\s_-]?key|private[\s_-]?key|credential|\bpin\b|\botp\b|\bcvv\b|\bcvc\b|\bssn\b|card[\s_-]?number/i;

/** One field of a form elicitation, as much of it as a question shows. */
interface Field {
  type?: string;
  title?: string;
  description?: string;
  enum?: string[];
  oneOf?: Array<{ const: string; title?: string }>;
  format?: string;
}

/**
 * Whether a field asks for what looks like a secret: its name, title or
 * description says so.
 *
 * @param name - The field's key.
 * @param field - Its schema.
 * @returns True for a password, a token, a key and the like.
 */
export function looksSecret(name: string, field: Field): boolean {
  return [name, field.title, field.description].some((text) => typeof text === 'string' && SECRET_LIKE.test(text));
}

/**
 * What kind of answer a field takes, in words a person reads.
 *
 * @param field - Its schema.
 * @returns "one of: a, b", "yes or no", "a date", and so on.
 */
function kindOf(field: Field): string {
  const choices = field.enum ?? field.oneOf?.map((option) => option.const);
  if (choices?.length) return `one of: ${choices.join(', ')}`;
  if (field.type === 'boolean') return 'yes or no';
  if (field.type === 'number' || field.type === 'integer') return 'a number';
  if (field.type === 'array') return 'a list';
  if (field.format) return `a ${field.format}`;
  return 'text';
}

/**
 * The question a run asks when a server elicits during one of its calls:
 * which server asked and during what, what it said, the fields it wanted
 * (any that look like a secret flagged), and where the reply goes. The last
 * part is for the next run as much as the person: the server asks again when
 * the tool is called again, so the reply has to reach it in the call.
 *
 * @param server - The server's display name.
 * @param tool - The qualified tool the run was calling.
 * @param params - The server's request.
 * @returns The question, standing on its own.
 */
export function elicitationQuestion(server: string, tool: string, params: ElicitRequestParams): string {
  const message = params.message.trim().slice(0, MESSAGE_CHARS) || '(no message)';
  const lines = [
    `The MCP server "${server}" asked for input during \`${tool}\`. A run cannot wait for a person ` +
      'mid-call, so it stopped here.',
    `${server} asks: ${message}`,
  ];
  if ('url' in params && typeof params.url === 'string') {
    lines.push(`It wants you to open: ${params.url}`);
  }
  const schema = 'requestedSchema' in params ? params.requestedSchema : undefined;
  const required = new Set(schema?.required ?? []);
  const fields = Object.entries((schema?.properties ?? {}) as Record<string, Field>);
  if (fields.length) {
    const listed = fields.slice(0, MAX_FIELDS).map(([name, field]) => {
      const label = field.title && field.title !== name ? `${field.title} (\`${name}\`)` : `\`${name}\``;
      const about = field.description ? `: ${field.description}` : '';
      const secret = looksSecret(name, field)
        ? ' — this looks like a secret. MCP servers must not ask for one this way: do not reply with it here.'
        : '';
      return `- ${label}, ${kindOf(field)}${required.has(name) ? ', required' : ''}${about}${secret}`;
    });
    if (fields.length > MAX_FIELDS) listed.push(`- and ${fields.length - MAX_FIELDS} more`);
    lines.push(`It wants:\n${listed.join('\n')}`);
  }
  lines.push(
    `Reply in this thread. The next run is shown this question and your reply. For that run: ${server} ` +
      `asks again when \`${tool}\` is called the same way, and the run stops again, so pass the reply to ` +
      'the tool in its arguments wherever it takes them.',
  );
  return lines.join('\n\n');
}
