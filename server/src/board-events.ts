// What changed on whose board, relayed from Postgres to the `boardChanged`
// subscription.
//
// The database announces every change itself (the `notify_board_change`
// trigger, db/drizzle/*_board_notify), so this is a relay, not a bus anything
// publishes to: one LISTEN per database, fanned out to the subscribers in this
// process. It also means a second server on the same database hears the same
// changes, with nothing to share between them.
//
// One relay per database handle, like `authFor` in the tests: a test's PGlite
// gets its own, and a notice from one test cannot reach another's subscriber.

// biome-ignore lint/suspicious/noExplicitAny: db type varies by driver (postgres-js, PGlite)
type AnyDb = any;

/** The trigger's channel. */
export const BOARD_CHANNEL = 'telos_board';

/** One change: whose, which project, and which table it was in. */
export interface BoardChange {
  userId: string;
  projectId: string;
  table: string;
}

type Listener = (change: BoardChange) => void;

/** The relay for one database. */
export interface BoardEvents {
  /** Resolves once LISTEN is in place, so a change made after it is heard. */
  listening(): Promise<void>;
  /**
   * The changes to one person's project, as they commit. Ends when the
   * consumer returns, which is what a client unsubscribing does.
   */
  watch(userId: string, projectId: string): AsyncIterableIterator<BoardChange>;
}

const relays = new WeakMap<object, BoardEvents>();

/**
 * The relay for `db`, started on first use.
 *
 * @param db The database the triggers write to.
 * @returns Its relay.
 */
export function boardEventsFor(db: AnyDb): BoardEvents {
  let relay = relays.get(db);
  if (!relay) {
    relay = createBoardEvents(db);
    relays.set(db, relay);
  }
  return relay;
}

/**
 * Listens on `db`'s client, whichever driver it is: postgres-js and PGlite
 * both take `listen(channel, callback)`.
 */
function listen(db: AnyDb, callback: (payload: string) => void): Promise<unknown> {
  const client = db.$client;
  if (typeof client?.listen !== 'function') {
    return Promise.reject(new Error('This database client cannot LISTEN, so boards will not update live.'));
  }
  return Promise.resolve(client.listen(BOARD_CHANNEL, callback));
}

function parse(payload: string): BoardChange | null {
  try {
    const change = JSON.parse(payload) as Partial<BoardChange>;
    if (typeof change.userId !== 'string' || typeof change.projectId !== 'string') return null;
    return { userId: change.userId, projectId: change.projectId, table: String(change.table ?? '') };
  } catch {
    return null;
  }
}

function createBoardEvents(db: AnyDb): BoardEvents {
  const listeners = new Set<Listener>();
  let started: Promise<unknown> | undefined;

  function start() {
    started ??= listen(db, (payload) => {
      const change = parse(payload);
      if (!change) return;
      for (const listener of listeners) listener(change);
    }).catch((error: unknown) => {
      // Not fatal: the board still works, it just has to be reloaded.
      console.error('[board-events]', error instanceof Error ? error.message : error);
      started = undefined;
    });
    return started;
  }

  return {
    async listening() {
      await start();
    },
    watch(userId, projectId) {
      // Hand-rolled rather than an async generator: a generator parked on an
      // `await` cannot be returned until the next change arrives, so a client
      // that left a quiet board would hold its listener until something moved.
      const queue: BoardChange[] = [];
      // Reads made before a change arrived, answered in the order they were made.
      const waiting: Array<(result: IteratorResult<BoardChange>) => void> = [];
      let done = false;

      const listener: Listener = (change) => {
        if (change.userId !== userId || change.projectId !== projectId) return;
        const resolve = waiting.shift();
        if (resolve) {
          resolve({ value: change, done: false });
        } else {
          queue.push(change);
        }
      };
      listeners.add(listener);
      void start();

      const finish = (): Promise<IteratorResult<BoardChange>> => {
        done = true;
        listeners.delete(listener);
        queue.length = 0;
        for (const resolve of waiting.splice(0)) resolve({ value: undefined, done: true });
        return Promise.resolve({ value: undefined, done: true });
      };

      const iterator: AsyncIterableIterator<BoardChange> = {
        next() {
          if (done) return Promise.resolve({ value: undefined, done: true });
          const next = queue.shift();
          if (next) return Promise.resolve({ value: next, done: false });
          return new Promise((resolve) => {
            waiting.push(resolve);
          });
        },
        return: finish,
        throw: (error?: unknown) => {
          void finish();
          return Promise.reject(error);
        },
        [Symbol.asyncIterator]() {
          return iterator;
        },
      };
      return iterator;
    },
  };
}
