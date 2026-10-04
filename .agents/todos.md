# Project Todos

Findings from the refactor workflow. IDs are stable — don't renumber when items are removed.
`(unverified)` marks items inferred from docs or naming rather than confirmed in code.
Nothing here is implemented until approved.

## Conventions

- Failures: GraphQL errors with a code (`NOT_FOUND`, `BAD_USER_INPUT`, `CONFLICT`) and a message that teaches the fix.
- App mutations: awaited in try/catch, shown with `describeError()`.
- Write rules for tables: `server/src/resolvers/write-guards.ts`. Readiness: one SQL query in `server/src/ready.ts`.
- Generated files: `app/src/lib/graphql.ts`, server schema types → `npm run codegen`; migrations → `db/drizzle/<ts>_<name>/migration.sql` (drizzle-kit).
- Baseline (2026-10-03, `refactor/agent-model` at e202fcf): types clean, biome 3 warnings, vitest 908/908.

## Model (agreed at Gate 1)

An **agent** is a model with instructions; blank settings come from **agent defaults**.
A **lane** is a column; given an agent, each ready todo in it becomes a **run**. A run
ends in success or failure, with a report and optionally new todos. Success follows the
lane's success route (a lane, or archive); failure follows its failure route. A **draft**
is a conversation with an agent that becomes a todo. Board templates save lanes.

- **M1** — One outcome for every run. Retire **contract**: the agent replies however it
  likes; a reply that starts with `FAIL` fails, one that starts with `PASS` passes (both
  saved as a verdict note), anything else is a report and passes. New todos may come from
  any run, in a fenced `todos` JSON block.
- **M2** — The agent is the reusable part. Retire **lane preset**, **job**, and the
  **lane prompt**: what a lane asks for is its agent's instructions.
- **M3** — Retire **station** as a word and as a code concept: "a lane with an agent".
- **M4** — Retire **agent template** as a concept: it becomes starter text in the new-agent form.

---

## Tests (pin first)

### T1 [pin] — How a finished run is read and routed, per today's contract

**File:** `server/src/__tests__/runs.test.ts`. Pin: work reply → report note, success
route; `FAIL` reply → verdict note, failure route, reason "The review failed."; `PASS`
→ verdict note, success; archive on success; a person's move wins; failed run → failure
route. These stay true after M1 for any agent, so they are rewritten in A2 only to drop
`contract` from setup. (Check which already exist; add only the missing ones.)

### T2 [pin] — The system prompt's layers

**File:** `runner/src/__tests__/prompts.test.ts` (unverified: may exist). Pin the order
project → agent instructions → standing protocol, so A3 can change the middle without
moving the ends.

---

## Features / API changes (need a decision)

These change behavior or saved data, so they are not refactors. One commit each.

### A1 — Migration: fold contract, preset and lane prompt into agents

**Status:** done in `feat!: read every run the same way…`, as a drop with **no data migration** (user's call): contracts, lane prompts and presets are lost, not folded into agents.

**Files:** new `db/drizzle/<ts>_agents_own_the_job/migration.sql`, `db/src/models/lanes.ts`,
`lane-presets.ts`, `board-templates.ts`, `runs.ts`, `index.ts`, `relations.ts`.
For each lane with an agent, its effective instructions are: agent prompt, then the
contract's role text (verdict: "review against acceptance, start with PASS or FAIL";
expand: "split into todos, as a `todos` block"; work: nothing), then the preset prompt,
then the lane prompt. Lanes whose result equals the agent's own prompt keep that agent.
Each other distinct (agent, instructions) pair gets one copy of the agent, named
`<agent> — <lane>` (first lane using it), with the same model fields, MCP servers and key.
Board templates' `TemplateLane` entries are rewritten the same way (their `agentId` is
remapped; `contract`, `prompt`, `presetId`, `presetOverrides` dropped). Then drop
`lanes.contract`, `lanes.prompt`, `lanes.preset_id`, `lanes.preset_overrides`, the
`lanes_follow_preset` trigger, `lane_presets`, and `runs.contract` (with `ck_runs_contract`
and the contract part of `ck_runs_owner`). Implements M1, M2. Needs T1.

### A2 — Server: one way to read a finished run

**Status:** done in `feat!: read every run the same way…`. Changed at Gate 2: new todos go to the project's new-todo lane (`projects.newTodoLaneId`, else the first open lane), so there is no "give this lane a success route" failure. Todos are taken only from a passing run.

**Files:** `server/src/resolvers/runs.ts:575-680` (`finish`), `briefFor` (`:280`), claim
(`:91`, `:312`, `:803`), `server/src/stations.ts:107,282` (`barren_expand`),
`write-guards.ts:53-61,277-346`, `resolvers/lane-presets.ts` and `server/src/lane-presets.ts`
(deleted), `board-templates.ts`, `ai-reads.ts`, `ai-setup.ts`, `mcp.graphql`, `mcp-prompts.ts`,
`build-schema.ts`. The verdict is read from every reply (`FAILS`, plus `PASS`); proposed
todos are accepted from every run. A run that proposes todos leaves its todo where it is
and puts them in the success route's lane (first open lane when that is the done lane);
with no success route the run fails with "Give this lane a success route so its new
todos have somewhere to go." `archiveOnSuccess` no longer has an expand exception.
GraphQL/MCP lose `Lane.contract`, `Lane.prompt`, `presetId`, `presetOverrides`, the lane
preset queries and mutations, and the claim's `contract`/`lanePrompt`. **Breaking** for MCP
clients that read those fields, and for a second runner on another host (it must upgrade
with the server). Implements M1–M3.

### A3 — Runner: one standing protocol

**Status:** done in `feat!: read every run the same way…`.

**Files:** `runner/src/prompts.ts` (`WORK_SYSTEM`, `VERDICT_SYSTEM`, `EXPAND_SYSTEM`, `JOBS`
→ one `STANDING_SYSTEM`; `proposedTodos` reads a fenced `todos` block from any reply),
`runner/src/telos.ts:75,225`, `runner/src/execute.ts:231,325,386`. System prompt: project,
agent instructions, standing protocol (do the work; report honestly; optionally start with
PASS/FAIL; optionally add a `todos` block). Implements M1. Needs T2, ships with A2.

### F1 — App: a lane's agent, with no station, preset or contract

**Status:** done in `feat!: read every run the same way…` and R1. The route moved from `/stations` to `/agents`, titled "Agents".

**Files:** `app/src/components/domain/ai/station-dialog.tsx` → `lane-agent-dialog.tsx`
(fields: Agent, On success → lane / archive, On failure → lane, WIP limit, Attempts);
`lane-preset-manager.tsx` and `app/src/lib/lane-presets.ts` deleted, with the "Lane
presets" settings tab; `lane-column.tsx`, `board.tsx`, `board-card.tsx` (menu "Station…"
→ "Agent…", badge "Station" → the agent's name); `ai-setup-checklist.tsx`,
`project-activity.tsx`, `ai-status.tsx`, `app/app/(app)/stations.tsx` (titled "Agents at
work"; route kept as `/stations` unless you say otherwise); `agent-manager.tsx`
description ("Models a lane can hand its todos to. A lane with an agent is a station.").
Implements M2, M3. Needs A2 (codegen).

### F2 — App: agent starters as starter text

**Status:** done in `feat(app): start a new agent from starter text that says its job`.

**Files:** `app/src/lib/agent-templates.ts` → starter instructions (Worker, Reviewer,
Planner, Refiner) without `use`; the reviewer's and planner's text carry what
`VERDICT_SYSTEM`/`EXPAND_SYSTEM` said (A3). Shown as "Start from" in the new-agent form.
Implements M4.

---

## Refactoring

### R1 [readability] — Retire "station" from server code names

**Status:** done, across server, db, runner and app (`ready.ts`, `WorkState`, `LaneAgentFields`, "Agent…", `/agents`). The public GraphQL names `StationTodo`, `AiStatusLane.station` and `AiSetup.station`/`stationProjectIds` stay (Gate 1: app and code only).

**Files:** `server/src/stations.ts` → `server/src/ready.ts` (unverified name);
comments and identifiers in `runs.ts`, `ai-status.ts`, `ai-setup.ts`, `retention.ts`,
`account-activity.ts`, `ai-switches.ts`, `db/src/models/runs.ts`. Behavior unchanged.
Implements M3. Needs A2 (do after, so the diff is names only).

### R2 [readability] — One word for routes

**Status:** done with R1.

Comments and copy say "arm", "arrow" and "route" for `onSuccessLaneId`/`onFailureLaneId`.
Use "success route" / "failure route" everywhere (code comments, UI copy, AGENTS.md).
Implements the glossary.

### R3 [readability] — Runner `Brief` → `Assignment`

**Files:** `runner/src/telos.ts`, `prompts.ts`, `execute.ts`; server's claim type in
`runs.ts:91`. "Brief" stays for the todo's brief only. GraphQL type rename is part of A2's
breaking change, so it costs no extra release.

---

## Docs

### D1 — AGENTS.md and README.md say the new model

**Status:** done with R1.

**Files:** `AGENTS.md` (stations, contracts, presets: about 30 lines), `README.md` (AI section).
Rewrite with the glossary and the explain-test paragraph. Last, after the code.

---

## Low value / later

### R4 [readability] — "request" means four things

`runRequestedAt`, `submitRequest`, the draft's "rough request", the agent form's
"Requests" group. Out of this PR's scope; rename separately if wanted.
