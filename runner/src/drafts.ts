import { askJson, errorMessage } from '@cubicecho/agent-core';
import type { ClaimedAgent, DraftAnswer, DraftClaim, Telos } from './telos.ts';

// A draft's turn: the agent reads the conversation so far and answers it,
// rewriting the draft's title and brief as it goes. Ported from kanban_server's
// refine chat. It is one model call with no tools: the agent is helping a
// person say what they want, not doing it.

export const REFINE_SYSTEM = `You help someone turn a rough request into a todo worth working on.

Ask about what is genuinely ambiguous, one or two things at a time — not a questionnaire. Where
the answer is obvious from what they have already said, assume it and say that you did. Keep the
brief in their vocabulary; do not pad it with sections they did not ask for.

Answer with JSON and nothing else:

{
  "reply": "what you say back to them",
  "title": "a short name for the todo",
  "brief": "the current best statement of the whole todo, rewritten each turn"
}

The brief becomes a todo, read by agents who will not see this conversation, so it has to stand
on its own. Carry forward everything already settled; never shorten it to a summary.`;

const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    title: { type: 'string' },
    brief: { type: 'string' },
  },
  required: ['reply', 'title', 'brief'],
  additionalProperties: false,
};

const DEFAULTS = { maxTokens: 4096, temperature: 0.3, requestTimeoutSeconds: 300 };

/**
 * The system prompt for a draft: the job, then where, then who the agent is.
 *
 * @param claim The draft.
 * @returns The system prompt.
 */
export function refineSystem(claim: DraftClaim): string {
  const where = [
    `Project: ${claim.projectName}`,
    claim.projectDescription ? `\n${claim.projectDescription}` : '',
    claim.projectContext ? `\n\n${claim.projectContext}` : '',
  ].join('');
  return [REFINE_SYSTEM, where, claim.agent.systemPrompt?.trim()].filter(Boolean).join('\n\n');
}

/**
 * The conversation as the agent reads it: the brief as it stands, then every
 * turn, theirs and its own.
 *
 * @param claim The draft.
 * @returns The user prompt.
 */
export function refinePrompt(claim: DraftClaim): string {
  const turns = claim.messages
    .map((message) => `${message.role === 'user' ? 'Them' : 'You'}: ${message.content}`)
    .join('\n\n');
  return `Current brief:\n${claim.brief || '(none yet)'}\n\nConversation so far:\n\n${turns}`;
}

/**
 * Has the agent answer a draft. Never throws: what went wrong is the answer.
 *
 * @param claim The draft.
 * @param options Cancellation, and the call to make (`askJson` unless a test says otherwise).
 * @returns What to report.
 */
export async function answerDraft(
  claim: DraftClaim,
  options: { signal?: AbortSignal; ask?: typeof askJson } = {},
): Promise<DraftAnswer> {
  const agent: ClaimedAgent = claim.agent;
  try {
    const answer = await (options.ask ?? askJson)<{ reply?: unknown; title?: unknown; brief?: unknown }>(
      {
        baseUrl: agent.baseUrl,
        apiKey: agent.apiKey ?? '',
        requestTimeoutSeconds: agent.requestTimeoutSeconds ?? DEFAULTS.requestTimeoutSeconds,
      },
      agent.model,
      refineSystem(claim),
      refinePrompt(claim),
      ANSWER_SCHEMA,
      {
        name: 'draft_turn',
        maxTokens: agent.maxTokens ?? DEFAULTS.maxTokens,
        temperature: agent.temperature ?? DEFAULTS.temperature,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
    const reply = text(answer?.reply);
    if (!reply) return { error: 'The agent did not answer in the shape asked for. Try saying it again.' };
    return { reply, title: text(answer?.title), brief: text(answer?.brief) };
  } catch (error) {
    return { error: errorMessage(error) || 'The agent could not be reached.' };
  }
}

/**
 * Takes waiting drafts, up to the room there is, and answers each in the
 * background, alongside runs.
 *
 * @param telos The runner's client.
 * @param room How many more the runner may take on.
 * @param running What is in flight, by key. Added to here, `draft:<id>`.
 * @param options Cancellation, where failures to report go, and the call to make.
 * @returns How many were taken.
 */
export async function takeDrafts(
  telos: Telos,
  room: number,
  running: Map<string, Promise<unknown>>,
  options: { signal?: AbortSignal; log: (text: string) => void; ask?: typeof askJson },
): Promise<number> {
  if (room <= 0) return 0;
  let taken = 0;
  for (const id of await telos.drafts(room * 2)) {
    if (taken >= room) break;
    const key = `draft:${id}`;
    if (running.has(key)) continue;
    const claim = await telos.claimDraft(id);
    if (!claim) continue;
    taken++;
    const turn = answerDraft(claim, options)
      .then((answer) => telos.finishDraft(id, answer))
      .catch((error) =>
        options.log(
          `[runner] reporting a draft's answer failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      .finally(() => running.delete(key));
    running.set(key, turn);
  }
  return taken;
}
