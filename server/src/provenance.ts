import { sql } from 'drizzle-orm';
import type { Actor } from './context.ts';

// Who changed a todo, for its history. The `todos_history` trigger (see the
// richer_todos migration) writes the event row itself and reads the actor from
// these transaction-local settings, so every write to `todos` has to happen in
// a transaction that called `stampActor` first. One that did not is recorded
// as 'system', which is wrong but visible, rather than silently missing.

// biome-ignore lint/suspicious/noExplicitAny: db type varies by driver (postgres-js, PGlite)
type AnyDb = any;

export interface Provenance {
  /** Why, in the actor's words. Shown on the event. */
  reason?: string | null | undefined;
  /** The note that explains the change, when there is one. */
  noteId?: string | null | undefined;
}

/**
 * Names the actor for the rest of `tx`. Every setting is written every time,
 * so an earlier stamp in the same transaction cannot leak its reason into a
 * later change. `is_local` confines them to the transaction: outside one they
 * would outlive the request on a pooled connection.
 */
export async function stampActor(tx: AnyDb, actor: Actor, provenance: Provenance = {}): Promise<void> {
  await tx.execute(sql`
    SELECT
      set_config('telos.actor_kind', ${actor.kind === 'anonymous' ? 'system' : actor.kind}, true),
      set_config('telos.actor_key_id', ${actor.keyId ?? ''}, true),
      set_config('telos.run_id', ${actor.runId ?? ''}, true),
      set_config('telos.note_id', ${provenance.noteId ?? ''}, true),
      set_config('telos.reason', ${provenance.reason ?? ''}, true)
  `);
}
