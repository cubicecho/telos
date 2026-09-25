import { sql } from 'drizzle-orm';
import { resultRows } from './blocking.ts';

// Old runs, pruned: each account says how many days a finished run and its log
// are kept (users.runRetentionDays; null is for good), and the server deletes
// what is older, at boot and every hour after.
//
// Only runs the stations no longer count go. A station reads a todo's runs to
// decide whether it is ready (stations.ts): its failures since a person last
// touched it, and an `ok` in its lane since it arrived there. Those are kept,
// however old, so pruning cannot wake a todo a station gave up on or finished
// with; both moments only move forward, so a run that stops counting never
// counts again. A done todo's runs all go: reopening one is a person's touch.
//
// What a run did stays: its notes and history keep their `runId`, pointing at
// a run that is gone, and its artifacts keep their files.

// biome-ignore lint/suspicious/noExplicitAny: db type varies by driver (postgres-js, PGlite)
type AnyDb = any;

/** How often the server prunes. */
export const PRUNE_EVERY_MS = 60 * 60_000;

/** The most days an account may keep runs for, short of for good. */
export const MAX_RETENTION_DAYS = 3650;

/**
 * Deletes the runs every account has kept past its retention.
 *
 * @param db The database.
 * @param now What time it is.
 * @returns How many runs went.
 */
export async function pruneRuns(db: AnyDb, now: Date = new Date()): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM runs r
    USING users u, todos t
    WHERE u.id = r.user_id AND t.id = r.todo_id
      AND u.run_retention_days IS NOT NULL
      AND r.status <> 'running'
      AND coalesce(r.finished_at, r.started_at) < ${now.toISOString()}::timestamptz - make_interval(days => u.run_retention_days)
      AND (
        t.completed_at IS NOT NULL
        OR NOT (
          -- A failure since a person last touched the todo: one of its attempts.
          ((r.status = 'error' OR r.verdict = 'fail') AND r.started_at > coalesce(
            (SELECT max(e.at) FROM todo_events e WHERE e.todo_id = t.id AND e.actor_kind = 'user'),
            '-infinity'::timestamptz
          ))
          -- A success here since it arrived: the station is done with it.
          OR (r.status = 'ok' AND r.lane_id = t.lane_id AND r.started_at >= coalesce(
            (SELECT max(e.at) FROM todo_events e WHERE e.todo_id = t.id AND e.to_lane_id = t.lane_id),
            t.created_at
          ))
        )
      )
    RETURNING r.id
  `);
  return resultRows(result).length;
}

/**
 * Prunes now, then every `everyMs`, until stopped.
 *
 * @param db The database.
 * @param options How often, and where to say what happened.
 * @param options.everyMs The interval.
 * @param options.log Told how many went, and about failures.
 * @returns Stops it.
 */
export function startPruning(
  db: AnyDb,
  { everyMs = PRUNE_EVERY_MS, log = console.log }: { everyMs?: number; log?: (text: string) => void } = {},
): () => void {
  const prune = () =>
    pruneRuns(db)
      .then((count) => {
        if (count > 0) log(`[retention] pruned ${count} old run${count === 1 ? '' : 's'}`);
      })
      .catch((error: unknown) => log(`[retention] pruning failed: ${error instanceof Error ? error.message : error}`));
  void prune();
  const timer = setInterval(prune, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
