import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { AgentMcpServer, LaneContract, NoteKind, TodoEventKind } from '@telos/db/schema';
import * as dbSchema from '@telos/db/schema';
import { eq, sql } from 'drizzle-orm';
import { assertNoBlockedCompletions, resultRows } from '../server/src/blocking.ts';
import { assertCompletionMatchesLane, assertEveryProjectHasLanes, DEFAULT_LANES } from '../server/src/lanes.ts';
import { stampActor } from '../server/src/provenance.ts';

// Copies a kanban_server board into telos, for one telos user.
//
//   node --experimental-strip-types scripts/import-kanban.ts \
//     --from <postgres-url|pglite-dir> --user <email> [--dry-run] [--rename]
//
// kanban_server is read with plain SQL and never imported: its code is not
// installed here, and what it stored is all this needs. Everything is written
// in one transaction, so an import either lands whole or not at all, and a
// dry run is the same import rolled back.
//
// The import is the one writer that does not go through the GraphQL write
// hooks, so it has to leave the rows those hooks would have: every invariant
// the server re-asserts over a user's rows after a write (lane and completion
// agree, nothing completed while blocked, every project has a lane, parents in
// their own project and acyclic) holds when it commits, or the user's next
// ordinary edit would be refused over data they never touched. The ones the
// server exports are run again at the end, inside the transaction.

// biome-ignore lint/suspicious/noExplicitAny: db type varies by driver (postgres-js, PGlite)
type AnyDb = any;
type Row = Record<string, unknown>;

/** kanban_server's database, as whatever answers raw SQL. */
export interface KanbanSource {
  query(text: string): Promise<Row[]>;
  close?(): Promise<void>;
}

export interface ImportOptions {
  source: KanbanSource;
  /** Telos's database: a drizzle handle over postgres-js or PGlite. */
  target: AnyDb;
  /** The telos user the board is copied to — by id, or by email. */
  userId?: string | undefined;
  email?: string | undefined;
  /** Do everything, report it, and roll it back. */
  dryRun?: boolean | undefined;
  /** Import a project whose name is taken as "<name> (kanban)" instead of refusing. */
  rename?: boolean | undefined;
}

export interface ImportReport {
  dryRun: boolean;
  userId: string;
  projects: Array<{ from: string; to: string; doneLane: string | null }>;
  /** Rows written, per telos table. */
  counts: Record<string, number>;
  /** What was read and deliberately not copied, and what changed on the way. */
  skipped: string[];
  notes: string[];
}

export const IMPORT_REASON = 'Imported from kanban_server';
const RENAME_SUFFIX = ' (kanban)';

/**
 * Lane names that mean "done". kanban_server has no done flag — a lane with no
 * role is a resting place, and which one is the finish line is only said by
 * its name — so this is the one guess the import makes. The last matching lane
 * on a board wins.
 */
const DONE_NAME = /^\s*(done|complete|completed|finished|shipped|closed)\s*$/i;

class DryRunRollback extends Error {}

// ─── Reading kanban_server ─────────────────────────────────────────────────

interface Kanban {
  settings: Row | null;
  roles: Row[];
  agents: Row[];
  mcpServers: Row[];
  agentServers: Row[];
  projects: Row[];
  lanes: Row[];
  tasks: number;
  cards: Row[];
  cardDeps: Row[];
  cardNotes: Row[];
  cardEvents: Row[];
  runs: number;
  artifacts: number;
}

async function readKanban(source: KanbanSource): Promise<Kanban> {
  const present = new Set(
    (
      await source.query(
        "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
      )
    ).map((row) => String(row.name)),
  );
  for (const required of ['projects', 'lanes', 'cards']) {
    if (!present.has(required)) {
      throw new Error(`The source has no "${required}" table — is it a kanban_server database?`);
    }
  }
  // `SELECT *` and defensive reads below, rather than naming columns: an older
  // kanban_server is missing some of them, and a missing column is a default.
  const all = async (table: string, order = '') =>
    present.has(table) ? source.query(`SELECT * FROM "${table}"${order ? ` ORDER BY ${order}` : ''}`) : [];
  const count = async (table: string) =>
    present.has(table) ? Number((await source.query(`SELECT count(*)::int AS n FROM "${table}"`))[0]?.n ?? 0) : 0;
  return {
    settings: (await all('settings'))[0] ?? null,
    roles: await all('roles'),
    agents: await all('agents', '"createdAt", id'),
    mcpServers: await all('mcp_servers'),
    agentServers: await all('agent_servers'),
    projects: await all('projects', '"createdAt", id'),
    lanes: await all('lanes', '"position", "createdAt", id'),
    tasks: await count('tasks'),
    cards: await all('cards', '"position", "createdAt", id'),
    cardDeps: await all('card_deps'),
    cardNotes: await all('card_notes', '"createdAt", id'),
    cardEvents: await all('card_events', '"createdAt", id'),
    runs: await count('runs'),
    artifacts: await count('artifacts'),
  };
}

const str = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value));
const orNull = (value: unknown): string | null => str(value).trim() || null;
const num = (value: unknown, fallback: number): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const date = (value: unknown): Date | null => {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
};
const record = (value: unknown): Record<string, string> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, string>) : {};

// ─── Mapping ───────────────────────────────────────────────────────────────

/**
 * kanban_server's agent knobs say "inherit from settings" with 0, -1 or ''.
 * Telos has no settings row to inherit from, so the inherited value is written
 * onto the agent, and an unset one becomes telos's own "unset" (null).
 */
function mapAgent(agent: Row, settings: Row | null) {
  const s = settings ?? {};
  const positive = (own: unknown, inherited: unknown) =>
    num(own, 0) > 0 ? num(own, 0) : num(inherited, 0) > 0 ? num(inherited, 0) : null;
  const nonNegative = (own: unknown, inherited: unknown) =>
    num(own, -1) >= 0 ? num(own, -1) : num(inherited, -1) >= 0 ? num(inherited, -1) : null;
  const temperature = nonNegative(agent.temperature, s.temperature);
  const discovery =
    str(agent.toolDiscovery) === 'inherit' || !agent.toolDiscovery ? str(s.toolDiscovery) : str(agent.toolDiscovery);
  const toolDiscovery = discovery === 'ondemand';
  return {
    name: str(agent.name) || 'Imported agent',
    baseUrl: str(agent.baseUrl) || str(s.baseUrl),
    model: str(agent.model) || str(s.model),
    systemPrompt: orNull(agent.systemPrompt),
    // `real` comes back as the nearest float — 0.699999988 for 0.7.
    temperature: temperature === null ? null : Math.round(temperature * 1000) / 1000,
    maxTokens: positive(agent.maxTokens, s.maxTokens),
    contextLength: positive(agent.contextLength, s.contextLength),
    maxToolIterations: positive(agent.maxToolIterations, s.maxToolIterations) ?? 20,
    toolDiscovery,
    toolSelectModel: toolDiscovery ? orNull(s.toolSelectModel) : null,
    requestTimeoutSeconds: positive(agent.requestTimeoutSeconds, s.requestTimeoutSeconds),
    maxRetries: nonNegative(agent.maxRetries, s.maxRetries),
  };
}

/** One of kanban_server's MCP servers in the shape `agents.mcpServers` holds, less its secrets. */
function mapServer(server: Row, notes: string[]): AgentMcpServer & { hiddenTools?: string[]; hooks?: unknown[] } {
  const slug = str(server.slug) || str(server.id);
  const entry: AgentMcpServer & { hiddenTools?: string[]; hooks?: unknown[] } = { id: slug };
  if (str(server.label)) entry.name = str(server.label);
  if (str(server.transport) === 'http' || (!server.command && server.url)) {
    entry.url = str(server.url);
  } else {
    entry.command = str(server.command);
    if (Array.isArray(server.args) && server.args.length > 0) entry.args = server.args.map(String);
  }
  if (Array.isArray(server.hiddenTools) && server.hiddenTools.length > 0)
    entry.hiddenTools = server.hiddenTools.map(String);
  if (Array.isArray(server.hooks) && server.hooks.length > 0) entry.hooks = server.hooks;
  // Headers and env are where MCP servers keep their tokens, and there is no
  // telling a token from a setting. Neither is copied; the names are reported
  // so they can be put back by hand.
  const dropped = [
    ...Object.keys(record(server.headers)).map((key) => `header ${key}`),
    ...Object.keys(record(server.env)).map((key) => `env ${key}`),
  ];
  if (dropped.length > 0)
    notes.push(`MCP server "${slug}": ${dropped.join(', ')} not copied (may hold secrets); re-enter them.`);
  const unmapped = ['cwd', 'connectTimeoutMs', 'callTimeoutMs'].filter(
    (key) => server[key] != null && server[key] !== '',
  );
  if (unmapped.length > 0) notes.push(`MCP server "${slug}": ${unmapped.join(', ')} has no telos equivalent; dropped.`);
  return entry;
}

/** Where a card was: a kanban lane id, or null for off the board (archived). */
type Place = string | null;

// ─── The import ────────────────────────────────────────────────────────────

export async function importKanban(options: ImportOptions): Promise<ImportReport> {
  const { source, target } = options;
  const kanban = await readKanban(source);
  const userId = await findUser(target, options);

  const report: ImportReport = {
    dryRun: !!options.dryRun,
    userId,
    projects: [],
    counts: { projects: 0, lanes: 0, agents: 0, todos: 0, todoDependencies: 0, todoNotes: 0, todoEvents: 0 },
    skipped: [],
    notes: [],
  };
  const { counts, skipped, notes } = report;

  try {
    await target.transaction(async (tx: AnyDb) => {
      // The trigger that writes todo history reads who did it from here.
      await stampActor(tx, { kind: 'user', userId }, { reason: IMPORT_REASON });

      const names = await projectNames(tx, userId, kanban.projects, !!options.rename);

      // ── Agents ──
      const agentMap = new Map<string, string>();
      const serversById = new Map(kanban.mcpServers.map((server) => [str(server.id), server]));
      const existingAgents: Array<{ id: string; name: string }> = await tx
        .select({ id: dbSchema.agents.id, name: dbSchema.agents.name })
        .from(dbSchema.agents)
        .where(eq(dbSchema.agents.userId, userId));
      const keyed: string[] = [];
      for (const agent of kanban.agents) {
        if (str(agent.apiKey)) keyed.push(str(agent.name));
        // Re-importing (with --rename) should not grow a second copy of every agent.
        const existing = existingAgents.find((row) => row.name === str(agent.name));
        if (existing) {
          agentMap.set(str(agent.id), existing.id);
          notes.push(`Agent "${existing.name}" already exists in telos; its lanes use that one, unchanged.`);
          continue;
        }
        const mapped = mapAgent(agent, kanban.settings);
        const servers = kanban.agentServers
          .filter((link) => str(link.agentId) === str(agent.id))
          .map((link) => serversById.get(str(link.serverId)))
          .filter((server): server is Row => !!server);
        const disabled = servers.filter((server) => server.enabled === false);
        if (disabled.length > 0) {
          skipped.push(
            `Agent "${mapped.name}": disabled MCP servers ${disabled.map((server) => `"${str(server.slug)}"`).join(', ')} not attached.`,
          );
        }
        const mcpServers = servers
          .filter((server) => server.enabled !== false)
          .map((server) => mapServer(server, notes));
        const id = randomUUID();
        await tx.insert(dbSchema.agents).values({
          id,
          userId,
          ...mapped,
          mcpServers,
          ...(date(agent.createdAt) ? { createdAt: date(agent.createdAt) } : {}),
        });
        agentMap.set(str(agent.id), id);
        counts.agents++;
        if (!mapped.model)
          notes.push(`Agent "${mapped.name}" has no model (none in kanban_server's settings either); set one.`);
        if (!mapped.baseUrl) notes.push(`Agent "${mapped.name}" has no base URL; set one.`);
        if (agent.enabled === false)
          notes.push(`Agent "${mapped.name}" was disabled in kanban_server; telos has no such flag.`);
      }
      if (keyed.length > 0 || str(kanban.settings?.apiKey)) {
        notes.push(
          `API keys are never copied${keyed.length > 0 ? ` (${keyed.join(', ')} had one)` : ''}${str(kanban.settings?.apiKey) ? ', including the one in kanban_server settings' : ''}. Set them in telos.`,
        );
      }

      const rolesById = new Map(kanban.roles.map((role) => [str(role.id), role]));
      const eventsByCard = groupBy(kanban.cardEvents, (event) => str(event.cardId));
      const todoMap = new Map<string, string>();
      const doneLaneOf = new Map<string, string | null>(); // kanban project id -> kanban lane id
      const laneMap = new Map<string, string>();
      const projectOfCard = new Map<string, string>();

      for (const project of kanban.projects) {
        const kanbanProjectId = str(project.id);
        const name = names.get(kanbanProjectId)!;
        const projectId = randomUUID();
        await tx.insert(dbSchema.projects).values({
          id: projectId,
          userId,
          name,
          description: orNull(project.description),
          context: orNull(project.context),
          // Never on: an import must not start agents. The user opens a
          // project to AI themselves, once they have looked at it.
          aiEnabled: false,
          ...(date(project.createdAt) ? { createdAt: date(project.createdAt) } : {}),
          ...(date(project.updatedAt) ? { updatedAt: date(project.updatedAt) } : {}),
        });
        counts.projects++;

        // ── Lanes ──
        const lanes = kanban.lanes.filter((lane) => str(lane.projectId) === kanbanProjectId);
        const doneLane = [...lanes].reverse().find((lane) => DONE_NAME.test(str(lane.name))) ?? null;
        doneLaneOf.set(kanbanProjectId, doneLane ? str(doneLane.id) : null);
        const ownLanes = new Set(lanes.map((lane) => str(lane.id)));
        const laneRows = lanes.map((lane, index) => {
          const id = randomUUID();
          laneMap.set(str(lane.id), id);
          const role = lane.roleId ? rolesById.get(str(lane.roleId)) : undefined;
          // A kanban lane with an agent but no role runs nothing; in telos an
          // agent alone makes a station, so it is left off.
          const agentId = role && lane.agentId ? (agentMap.get(str(lane.agentId)) ?? null) : null;
          if (!role && lane.agentId) {
            skipped.push(
              `Lane "${str(lane.name)}" in "${name}": agent not attached (no role, so it never ran in kanban_server).`,
            );
          }
          const contract = (
            ['work', 'verdict', 'expand'].includes(str(role?.contract)) ? str(role?.contract) : 'work'
          ) as LaneContract;
          const prompt = [str(role?.prompt), str(lane.prompt)]
            .map((part) => part.trim())
            .filter(Boolean)
            .join('\n\n');
          return {
            id,
            userId,
            projectId,
            name: str(lane.name) || `Lane ${index + 1}`,
            position: index,
            isDone: lane === doneLane,
            agentId,
            contract,
            prompt: prompt || null,
            wipLimit: Math.max(1, num(lane.wipLimit, 1)),
            // Both count failures a station tolerates before it waits for a
            // person, and 0 means "no second go" in both.
            maxAttempts: Math.max(0, num(lane.maxAttempts, 0)),
            ...(date(lane.createdAt) ? { createdAt: date(lane.createdAt) } : {}),
            // Arrows are filled in once every lane has its new id.
            source: lane,
          };
        });
        if (laneRows.length === 0) {
          // Telos requires a board. A project with no lanes had no cards either.
          const seeded = DEFAULT_LANES.map((lane) => ({ id: randomUUID(), userId, projectId, ...lane }));
          await tx.insert(dbSchema.lanes).values(seeded);
          counts.lanes += seeded.length;
          notes.push(`"${name}" had no lanes; it got telos's default board.`);
          report.projects.push({ from: str(project.name), to: name, doneLane: 'Done' });
        } else {
          await tx.insert(dbSchema.lanes).values(laneRows.map(({ source: _source, ...row }) => row));
          counts.lanes += laneRows.length;
          for (const row of laneRows) {
            const arrow = (key: 'onSuccessLaneId' | 'onFailureLaneId') => {
              const to = str(row.source[key]);
              return to && ownLanes.has(to) ? laneMap.get(to)! : null;
            };
            let onSuccessLaneId = arrow('onSuccessLaneId');
            const onFailureLaneId = arrow('onFailureLaneId');
            if (row.source.archiveOnSuccess === true && !onSuccessLaneId) {
              // Archiving is how a kanban pipeline ended, and archived cards
              // arrive completed, so the nearest thing is the done lane.
              onSuccessLaneId = doneLane ? laneMap.get(str(doneLane.id))! : null;
              notes.push(
                `Lane "${row.name}" in "${name}" archived on success; ${doneLane ? `it now sends to "${str(doneLane.name)}"` : 'telos has no archive, so it has no success arrow'}.`,
              );
            }
            if (onSuccessLaneId || onFailureLaneId) {
              await tx
                .update(dbSchema.lanes)
                .set({ onSuccessLaneId, onFailureLaneId })
                .where(eq(dbSchema.lanes.id, row.id));
            }
          }
          report.projects.push({ from: str(project.name), to: name, doneLane: doneLane ? str(doneLane.name) : null });
          if (!doneLane) {
            notes.push(
              `"${name}": no lane is named like Done, so no lane means done and only archived cards arrive completed. Mark one as done in telos if the board has one.`,
            );
          }
        }

        for (const card of kanban.cards) {
          if (str(card.projectId) === kanbanProjectId) projectOfCard.set(str(card.id), projectId);
        }
      }

      // ── Todos ──
      // Completion is what the lane says, since that is the one thing telos
      // insists on: in the done lane is completed, anywhere else is open. An
      // archived card was put away, and completed is telos's only "put away".
      interface Planned {
        card: Row;
        id: string;
        projectId: string;
        laneId: string;
        completedAt: Date | null;
        parent: string | null;
        sortKey: [number, number, number, number];
      }
      const planned = new Map<string, Planned>();
      const lanePosition = new Map(kanban.lanes.map((lane) => [str(lane.id), num(lane.position, 0)]));
      let archived = 0;
      for (const card of kanban.cards) {
        const cardId = str(card.id);
        const projectId = projectOfCard.get(cardId);
        if (!projectId || !laneMap.has(str(card.laneId))) {
          skipped.push(`Card "${str(card.title)}": its project or lane is missing in kanban_server.`);
          continue;
        }
        const doneLaneId = doneLaneOf.get(str(card.projectId)) ?? null;
        const archivedAt = date(card.archivedAt);
        let kanbanLane = str(card.laneId);
        let completedAt: Date | null = null;
        if (archivedAt) {
          archived++;
          completedAt = archivedAt;
          if (doneLaneId) kanbanLane = doneLaneId;
        } else if (doneLaneId && kanbanLane === doneLaneId) {
          const arrived = (eventsByCard.get(cardId) ?? []).filter((event) => str(event.toLaneId) === doneLaneId).at(-1);
          completedAt = date(arrived?.createdAt) ?? date(card.updatedAt) ?? new Date();
        }
        planned.set(cardId, {
          card,
          id: randomUUID(),
          projectId,
          laneId: laneMap.get(kanbanLane)!,
          completedAt,
          parent: orNull(card.parentId),
          sortKey: [
            lanePosition.get(kanbanLane) ?? 0,
            archivedAt ? 1 : 0,
            num(card.position, 0),
            date(card.createdAt)?.getTime() ?? 0,
          ],
        });
      }
      if (archived > 0) notes.push(`${archived} archived card(s) imported as completed todos.`);

      // Parents: in the same project (telos refuses anything else), and no
      // chain that comes back around.
      for (const plan of planned.values()) {
        if (!plan.parent) continue;
        const parent = planned.get(plan.parent);
        if (!parent || parent.projectId !== plan.projectId) {
          skipped.push(
            `Card "${str(plan.card.title)}": parent ${parent ? 'is in another project' : 'was not imported'}; left without one.`,
          );
          plan.parent = null;
        }
      }
      const depth = new Map<string, number>();
      const depthOf = (cardId: string, seen: Set<string>): number => {
        const known = depth.get(cardId);
        if (known !== undefined) return known;
        const plan = planned.get(cardId)!;
        if (!plan.parent) {
          depth.set(cardId, 0);
          return 0;
        }
        if (seen.has(plan.parent)) {
          skipped.push(`Card "${str(plan.card.title)}": its parent chain loops; left without a parent.`);
          plan.parent = null;
          depth.set(cardId, 0);
          return 0;
        }
        seen.add(cardId);
        const d = depthOf(plan.parent, seen) + 1;
        depth.set(cardId, d);
        return d;
      };
      for (const cardId of planned.keys()) depthOf(cardId, new Set([cardId]));
      for (const [cardId, plan] of planned) todoMap.set(cardId, plan.id);

      // `position` is project-wide in telos: one sequence, board order.
      const byProject = groupBy([...planned.values()], (plan) => plan.projectId);
      const positions = new Map<string, number>();
      for (const plans of byProject.values()) {
        plans.sort((a, b) => compareKeys(a.sortKey, b.sortKey));
        for (const [index, plan] of plans.entries()) positions.set(plan.id, index);
      }

      // Parents before children, so every parent_id names a row already there.
      const ordered = [...planned.entries()].sort(([a], [b]) => depth.get(a)! - depth.get(b)!);
      const todoRows = ordered.map(([, plan]) => ({
        id: plan.id,
        userId,
        projectId: plan.projectId,
        title: str(plan.card.title) || 'Untitled',
        notes: orNull(plan.card.body),
        acceptance: orNull(plan.card.acceptance),
        parentId: plan.parent ? todoMap.get(plan.parent)! : null,
        laneId: plan.laneId,
        completedAt: plan.completedAt,
        position: positions.get(plan.id)!,
        ...(date(plan.card.createdAt) ? { createdAt: date(plan.card.createdAt)! } : {}),
        ...(date(plan.card.updatedAt) ? { updatedAt: date(plan.card.updatedAt)! } : {}),
      }));
      const depthOfTodo = new Map(ordered.map(([cardId, plan]) => [plan.id, depth.get(cardId)!]));
      for (const level of groupBy(todoRows, (row) => String(depthOfTodo.get(row.id))).values()) {
        for (const chunk of chunks(level, 500)) await tx.insert(dbSchema.todos).values(chunk);
      }
      counts.todos = todoRows.length;
      if (kanban.tasks > 0)
        skipped.push(
          `${kanban.tasks} task(s) and their message threads (telos has requests instead; cards made from them are imported).`,
        );

      // ── Dependencies ──
      // Kept acyclic, and never leaving a completed todo waiting on an open
      // one: telos checks both over all of a user's todos after every write.
      const edges = new Map<string, Set<string>>();
      const reaches = (from: string, to: string): boolean => {
        const stack = [from];
        const seen = new Set<string>();
        while (stack.length > 0) {
          const at = stack.pop()!;
          if (at === to) return true;
          if (seen.has(at)) continue;
          seen.add(at);
          stack.push(...(edges.get(at) ?? []));
        }
        return false;
      };
      const depRows: Array<{ id: string; userId: string; todoId: string; dependsOnTodoId: string }> = [];
      for (const dep of kanban.cardDeps) {
        const blocked = planned.get(str(dep.cardId));
        const blocker = planned.get(str(dep.dependsOnCardId));
        if (!blocked || !blocker) continue;
        const title = str(blocked.card.title);
        if (blocked.id === blocker.id || reaches(blocker.id, blocked.id)) {
          skipped.push(`Dependency "${title}" → "${str(blocker.card.title)}": would close a cycle.`);
          continue;
        }
        if (blocked.completedAt && !blocker.completedAt) {
          skipped.push(
            `Dependency "${title}" → "${str(blocker.card.title)}": "${title}" is done, so it no longer waits on anything.`,
          );
          continue;
        }
        if (edges.get(blocked.id)?.has(blocker.id)) continue;
        edges.set(blocked.id, (edges.get(blocked.id) ?? new Set()).add(blocker.id));
        depRows.push({ id: randomUUID(), userId, todoId: blocked.id, dependsOnTodoId: blocker.id });
      }
      for (const chunk of chunks(depRows, 500)) await tx.insert(dbSchema.todoDependencies).values(chunk);
      counts.todoDependencies = depRows.length;

      // ── Notes ──
      const noteMap = new Map<string, string>();
      const noteRows = kanban.cardNotes.flatMap((note) => {
        const todoId = todoMap.get(str(note.cardId));
        if (!todoId || !str(note.body).trim()) return [];
        const id = randomUUID();
        noteMap.set(str(note.id), id);
        const kind = (['note', 'report', 'verdict'].includes(str(note.kind)) ? str(note.kind) : 'note') as NoteKind;
        return [
          {
            id,
            userId,
            todoId,
            kind,
            body: str(note.body),
            actorKind: str(note.author) === 'agent' ? ('agent' as const) : ('user' as const),
            ...(date(note.createdAt) ? { createdAt: date(note.createdAt)! } : {}),
          },
        ];
      });
      for (const chunk of chunks(noteRows, 500)) await tx.insert(dbSchema.todoNotes).values(chunk);
      counts.todoNotes = noteRows.length;

      // ── History ──
      // The trigger wrote one `create` per todo, stamped now. It is moved to
      // when the card was made, and every later move the ledger recorded is
      // added after it. kanban_server's events have no kind; the change in
      // completion across the move says which of telos's it was.
      const doneKanbanLanes = new Set([...doneLaneOf.values()].filter((id): id is string => !!id));
      const completedIn = (place: Place) => place === null || doneKanbanLanes.has(place);
      const actorOf = (value: unknown) =>
        (['agent', 'user', 'system'].includes(str(value)) ? str(value) : 'user') as 'agent' | 'user' | 'system';
      const createdStamps: Array<{ todoId: string; at: Date; actor: string }> = [];
      const eventRows: Array<Record<string, unknown>> = [];
      for (const [cardId, plan] of planned) {
        const events = eventsByCard.get(cardId) ?? [];
        const [first, ...rest] = events;
        const creation = first && !first.fromLaneId ? first : null;
        createdStamps.push({
          todoId: plan.id,
          at: date(plan.card.createdAt) ?? date(creation?.createdAt) ?? new Date(),
          actor: creation ? actorOf(creation.actor) : 'user',
        });
        for (const event of creation ? rest : events) {
          const from: Place = orNull(event.fromLaneId);
          const to: Place = orNull(event.toLaneId);
          const before = completedIn(from);
          const after = completedIn(to);
          const kind: TodoEventKind = !before && after ? 'complete' : before && !after ? 'reopen' : 'move';
          eventRows.push({
            id: randomUUID(),
            userId,
            todoId: plan.id,
            kind,
            fromLaneId: from ? (laneMap.get(from) ?? null) : null,
            toLaneId: to ? (laneMap.get(to) ?? null) : null,
            actorKind: actorOf(event.actor),
            noteId: event.noteId ? (noteMap.get(str(event.noteId)) ?? null) : null,
            reason: IMPORT_REASON,
            at: date(event.createdAt) ?? new Date(),
          });
        }
      }
      for (const chunk of chunks(createdStamps, 500)) {
        const values = sql.join(
          chunk.map(
            (stamp) => sql`(${stamp.todoId}::uuid, ${stamp.at.toISOString()}::timestamptz, ${stamp.actor}::text)`,
          ),
          sql`, `,
        );
        await tx.execute(sql`
          UPDATE todo_events e SET at = v.at, actor_kind = v.actor
          FROM (VALUES ${values}) AS v(todo_id, at, actor)
          WHERE e.todo_id = v.todo_id AND e.kind = 'create'
        `);
      }
      for (const chunk of chunks(eventRows, 500)) await tx.insert(dbSchema.todoEvents).values(chunk);
      counts.todoEvents = createdStamps.length + eventRows.length;

      if (kanban.runs > 0) skipped.push(`${kanban.runs} run(s): runs are not imported.`);
      if (kanban.artifacts > 0)
        skipped.push(`${kanban.artifacts} artifact(s): they belong to runs, which are not imported.`);

      // The server's own checks, over everything this user now has. Any
      // failure here is a bug in the import, and rolls it all back.
      await assertCompletionMatchesLane(tx, userId);
      await assertNoBlockedCompletions(tx, userId);
      await assertEveryProjectHasLanes(tx, userId);
      await assertParentsInProject(tx, userId);

      if (options.dryRun) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  return report;
}

async function findUser(target: AnyDb, options: ImportOptions): Promise<string> {
  if (options.userId) {
    const rows = await target
      .select({ id: dbSchema.users.id })
      .from(dbSchema.users)
      .where(eq(dbSchema.users.id, options.userId));
    if (rows.length === 0) throw new Error(`No telos user with id ${options.userId}.`);
    return options.userId;
  }
  if (!options.email) throw new Error('Say which telos user to import into (--user <email>).');
  const rows: Array<{ id: string }> = await target
    .select({ id: dbSchema.users.id })
    .from(dbSchema.users)
    .where(sql`lower(${dbSchema.users.email}) = lower(${options.email})`);
  if (rows.length === 0) {
    throw new Error(
      `No telos user has the email ${options.email}. Sign in to telos once to create the account, then import.`,
    );
  }
  return rows[0].id;
}

/**
 * The name each kanban project will have. Refuses the whole import when one is
 * taken, unless renaming — an import that half-landed next to an earlier one
 * is harder to untangle than one that did not start.
 */
async function projectNames(tx: AnyDb, userId: string, projects: Row[], rename: boolean): Promise<Map<string, string>> {
  const existing: Array<{ name: string }> = await tx
    .select({ name: dbSchema.projects.name })
    .from(dbSchema.projects)
    .where(eq(dbSchema.projects.userId, userId));
  const taken = new Set(existing.map((row) => row.name));
  const clashes = projects.map((project) => str(project.name)).filter((name) => taken.has(name));
  if (clashes.length > 0 && !rename) {
    throw new Error(
      `Already in telos: ${clashes.map((name) => `"${name}"`).join(', ')}. Nothing was imported. ` +
        `Pass --rename to import them as "<name>${RENAME_SUFFIX}", or rename or delete the telos project first.`,
    );
  }
  const names = new Map<string, string>();
  for (const project of projects) {
    const base = str(project.name) || 'Imported project';
    let name = base;
    for (let n = 1; taken.has(name); n++) name = `${base}${n === 1 ? RENAME_SUFFIX : ` (kanban ${n})`}`;
    taken.add(name);
    names.set(str(project.id), name);
  }
  return names;
}

/** The half of write-guards.ts's `assertParentsSound` the import could break, which it does not export. */
async function assertParentsInProject(tx: AnyDb, userId: string): Promise<void> {
  const rows = resultRows(
    await tx.execute(sql`
      SELECT 1 FROM todos child JOIN todos parent ON parent.id = child.parent_id
      WHERE child.user_id = ${userId} AND parent.project_id <> child.project_id
      LIMIT 1
    `),
  );
  if (rows.length > 0) throw new Error('Import left a todo whose parent is in another project; rolled back.');
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// ─── Opening the source ────────────────────────────────────────────────────

interface PgliteLike {
  query<T>(text: string): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

/** A PGlite instance as a source. */
export function fromPglite(client: PgliteLike): KanbanSource {
  return { query: async (text) => (await client.query<Row>(text)).rows, close: () => client.close() };
}

/**
 * Opens kanban_server's database: a `postgres://` URL, or the directory PGlite
 * keeps it in (kanban_server's `data/pg` by default).
 */
export async function openSource(from: string): Promise<KanbanSource> {
  if (/^postgres(ql)?:\/\//.test(from)) {
    const { default: postgres } = await import('postgres');
    // Read-only at the session level, so no statement here can change it.
    const client = postgres(from, { max: 1, onnotice: () => {}, connection: { default_transaction_read_only: true } });
    return {
      query: async (text) => (await client.unsafe(text)) as unknown as Row[],
      close: () => client.end(),
    };
  }
  return openPgliteDir(from);
}

/**
 * PGlite takes no lock and may write to a directory it opens, so the import
 * works on a copy and refuses while kanban_server is running on the original.
 * It also has to be a PGlite that reads that directory's Postgres version, so
 * kanban_server's own, found by walking up from the directory, comes first.
 */
async function openPgliteDir(dir: string): Promise<KanbanSource> {
  const store = path.resolve(dir);
  if (!fs.existsSync(path.join(store, 'PG_VERSION'))) {
    throw new Error(
      `${store} is not a PGlite data directory (no PG_VERSION). Pass kanban_server's data/pg, or a postgres:// URL.`,
    );
  }
  const lock = `${store}.lock`;
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8').trim());
    if (pid && isAlive(pid)) throw new Error(`kanban_server (process ${pid}) has ${store} open. Stop it first.`);
  }
  const wanted = fs.readFileSync(path.join(store, 'PG_VERSION'), 'utf8').trim();
  const { PGlite, from } = await loadPglite(store);

  const probe = new PGlite();
  const version = String(
    (await probe.query<{ v: string }>("SELECT current_setting('server_version') AS v")).rows[0]?.v ?? '',
  );
  await probe.close();
  if (version.split('.')[0] !== wanted) {
    throw new Error(
      `${store} was written by Postgres ${wanted}, but the PGlite at ${from} is Postgres ${version}. ` +
        'Run `npm install` in kanban_server so its own PGlite is used, or export to a postgres server and pass its URL.',
    );
  }

  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'telos-kanban-import-'));
  fs.cpSync(store, path.join(copy, 'pg'), { recursive: true });
  const client = new PGlite(path.join(copy, 'pg'));
  return {
    ...fromPglite(client),
    close: async () => {
      await client.close();
      fs.rmSync(copy, { recursive: true, force: true });
    },
  };
}

type PgliteCtor = new (dataDir?: string) => PgliteLike & { query<T>(text: string): Promise<{ rows: T[] }> };

async function loadPglite(start: string): Promise<{ PGlite: PgliteCtor; from: string }> {
  for (let dir = start; ; dir = path.dirname(dir)) {
    const pkg = path.join(dir, 'node_modules', '@electric-sql', 'pglite');
    if (fs.existsSync(path.join(pkg, 'package.json'))) {
      const module = await import(pathToFileURL(path.join(pkg, 'dist', 'index.js')).href);
      return { PGlite: module.PGlite as PgliteCtor, from: pkg };
    }
    if (path.dirname(dir) === dir) break;
  }
  const module = await import('@electric-sql/pglite');
  return { PGlite: module.PGlite as unknown as PgliteCtor, from: "telos's @electric-sql/pglite" };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ─── CLI ───────────────────────────────────────────────────────────────────

export function formatReport(report: ImportReport): string {
  const lines = [report.dryRun ? 'Dry run: nothing was written.' : 'Imported.', ''];
  for (const project of report.projects) {
    lines.push(
      `  ${project.from}${project.to !== project.from ? ` → ${project.to}` : ''} (done lane: ${project.doneLane ?? 'none'})`,
    );
  }
  lines.push('', report.dryRun ? 'Would write:' : 'Wrote:');
  for (const [table, count] of Object.entries(report.counts)) lines.push(`  ${table.padEnd(18)} ${count}`);
  if (report.skipped.length > 0) lines.push('', 'Not copied:', ...report.skipped.map((line) => `  - ${line}`));
  if (report.notes.length > 0) lines.push('', 'Notes:', ...report.notes.map((line) => `  - ${line}`));
  lines.push('', 'AI is off on every imported project; switch it on per project when you are ready.');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      user: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      rename: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help || !values.from || !values.user) {
    console.log(
      'Usage: npm run import:kanban -- --from <postgres-url|pglite-dir> --user <email> [--dry-run] [--rename]\n\n' +
        "  --from     kanban_server's database: its DATABASE_URL, or its PGlite directory (data/pg)\n" +
        '  --user     the telos account to import into, by email\n' +
        '  --dry-run  do the import, print what it would write, and roll it back\n' +
        '  --rename   import a project whose name is taken as "<name> (kanban)" instead of refusing',
    );
    process.exitCode = values.help ? 0 : 1;
    return;
  }
  // Imported here, not at the top: `@telos/db` connects on import and demands
  // DATABASE_URL, which the tests (and --help) should not need.
  const { db } = await import('@telos/db');
  const source = await openSource(values.from);
  try {
    const report = await importKanban({
      source,
      target: db,
      email: values.user,
      dryRun: values['dry-run'],
      rename: values.rename,
    });
    console.log(formatReport(report));
  } finally {
    await source.close?.();
    await db.$client?.end?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
