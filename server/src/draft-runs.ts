import * as dbSchema from '@telos/db/schema';
import { and, eq, sql } from 'drizzle-orm';

// A draft's replies as runs. Each time an agent answers a draft, that answer is
// a run of kind `draft`: the same row a station's work leaves, with no todo, no
// lane and no contract. The run holds the lease while the agent answers, so
// "is somebody answering this draft" and "is somebody working this todo" are
// asked the same way.
//
// Kept apart from resolvers/drafts.ts so resolvers/runs.ts can stop a draft's
// run without the two resolver files importing each other.

// biome-ignore lint/suspicious/noExplicitAny: db type varies by driver (postgres-js, PGlite)
type AnyDb = any;

/**
 * How long the runner holds a draft it is answering. There is no heartbeat:
 * one answer is one model call, so this is set well past a slow model's
 * timeout. A draft held past it is taken again.
 */
export const DRAFT_LEASE_SECONDS = 600;

/** What a reply the runner never reported is recorded as. */
export const DRAFT_LEASE_LAPSED = 'The runner stopped before the agent answered.';

/**
 * Whether a draft has a reply under way: a running run whose lease still
 * holds, as SQL over the `drafts` table.
 *
 * @returns The condition.
 */
export function draftBeingAnswered() {
  return sql`EXISTS (
    SELECT 1 FROM runs r
    WHERE r.draft_id = ${dbSchema.drafts.id} AND r.status = 'running' AND r.lease_expires_at > now()
  )`;
}

/**
 * Marks a draft's running run as failed when its lease has lapsed: its runner
 * died, and the draft should be free to be taken again.
 *
 * @param db - The database or transaction.
 * @param draftId - The draft.
 * @returns Nothing.
 */
export async function expireLapsedDraftRuns(db: AnyDb, draftId: string): Promise<void> {
  await db.execute(sql`
    UPDATE runs
    SET status = 'error', error = ${DRAFT_LEASE_LAPSED}, finished_at = now()
    WHERE status = 'running' AND lease_expires_at <= now() AND draft_id = ${draftId}
  `);
}

/**
 * Stops waiting for a draft's answer: the draft takes its turn back and the
 * run answering it, if there is one, is stopped.
 *
 * @param db - The database or transaction.
 * @param draftId - The draft.
 * @returns The draft as it now stands.
 */
export async function stopDraftReply(db: AnyDb, draftId: string): Promise<dbSchema.Draft> {
  const [draft] = await db
    .update(dbSchema.drafts)
    .set({ waitingSince: null })
    .where(eq(dbSchema.drafts.id, draftId))
    .returning();
  await stopDraftRuns(db, draftId);
  return draft;
}

/**
 * Stops the reply a draft is waiting on, if one is under way. The run ends
 * here, as `stopped`, rather than waiting for the runner to hear about it: a
 * draft's answer is one model call with no heartbeat to hear it on, and
 * whatever the runner reports afterwards is dropped.
 *
 * @param db - The database or transaction.
 * @param draftId - The draft.
 * @returns Nothing.
 */
export async function stopDraftRuns(db: AnyDb, draftId: string): Promise<void> {
  const now = new Date();
  await db
    .update(dbSchema.runs)
    .set({ status: 'stopped', cancelRequestedAt: now, finishedAt: now })
    .where(and(eq(dbSchema.runs.draftId, draftId), eq(dbSchema.runs.status, 'running')));
}
