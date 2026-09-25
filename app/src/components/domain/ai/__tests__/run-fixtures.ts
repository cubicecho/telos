import { RunDocument } from '@/lib/graphql';

// Runs as the API answers them, for the tests of the views that draw them.

export function run(id: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    __typename: 'Run',
    id,
    status,
    verdict: 'none',
    contract: 'work',
    error: null,
    toolCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    model: 'qwen3',
    startedAt: '2026-09-24T10:00:00.000Z',
    finishedAt: status === 'running' ? null : '2026-09-24T10:01:00.000Z',
    cancelRequestedAt: null,
    agent: { __typename: 'Agent', id: 'a1', name: 'Reviewer' },
    lane: { __typename: 'Lane', id: 'l1', name: 'Review' },
    todo: { __typename: 'Todo', id: 't1', title: 'Write it' },
    ...extra,
  };
}

/** A run with everything an open row asks for: its log, prompts and output. */
export function fullRun(id: string, status: string, extra: Record<string, unknown> = {}) {
  return { ...run(id, status), output: null, events: [], systemPrompt: null, userPrompt: null, ...extra };
}

export function runMock(row: ReturnType<typeof fullRun>) {
  return { request: { query: RunDocument, variables: { id: row.id } }, result: { data: { run: row } } };
}
