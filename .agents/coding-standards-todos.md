# Coding standards ledger

Findings from the `coding-standards` skill's refactor workflow. What the system is lives in
`.agents/domain-model.md`; this file holds what should change. IDs are stable — don't renumber when items are removed.
`(unverified)` marks items inferred from docs or naming rather than confirmed in code.
Nothing here is implemented until approved.

## Conventions

- Failures: GraphQL errors with a code (`NOT_FOUND`, `BAD_USER_INPUT`, `CONFLICT`) and a message that teaches the fix.
- App mutations: awaited in try/catch, shown with `describeError()`.
- Write rules for tables: `server/src/resolvers/write-guards.ts`. Readiness: one SQL query in `server/src/ready.ts`.
- Generated files: `app/src/lib/graphql.ts`, server schema types → `npm run codegen`; migrations → `db/drizzle/<ts>_<name>/migration.sql` (drizzle-kit).
- Baseline (2026-10-03, `refactor/agent-model` at e202fcf): types clean, biome 3 warnings, vitest 908/908.

## Summary

| ID | Kind | What it does | Buys | Needs | Status |
|---|---|---|---|---|---|
| M1 | Model change | Every run's reply is read one way: PASS, FAIL or a report, with optional new todos | One outcome rule instead of three contracts | — | done |
| M2 | Model change | The agent is the reusable part; lane presets, jobs and lane prompts go | One place for what a lane asks for | — | done |
| M3 | Model change | "Station" is retired: a lane with an agent | One fewer word for the same thing | — | done |
| M4 | Model change | Agent templates become starter text in the new-agent form | One fewer concept | — | done |
| M5 | Model change | A split todo becomes an umbrella that no agent works and that completes with its pieces | A split parent is never re-planned, and needs no blocker edges | — | done |
| M6 | Model change | Lanes get a role (plan, work, review) that says which outcomes count there | A planner that does the work, or a reviewer that splits, fails instead of passing | M5 | declined |
| M7 | Model change | A refine may also set its todo's dependencies | A planner can say what its todo waits on, still only through `finishRun` | — | approved |
| M8 | Model change | One blocked rule: a blocked todo moves between open lanes, never into the done lane | A person and a route follow the same rule | — | approved |
| M9 | Model change | `attention` becomes **handed back**, one rule everywhere | One name for "its agent is done with it and it cannot move on without you" | — | done |
| M10 | Model change | Starters are **agent templates**; the Refiner template goes | A template is what people call starting text; refining is the Planner's job | — | approved |
| A4 | API change | A todo's `notes` column and every `brief` become **description** | "Notes" is the thread; "brief" is a second word for the same field | — | approved |
| R5 | Refactor [readability] | Retire "assignment": a run is handed its todo, with context | One word for the thing being worked | — | approved |
| A5 | API change | `submitRequest` becomes `fileTodo`; `cancelRequest` becomes `markHandsOff` | "Request" names no thing: one makes a todo in the new-todo lane, the other marks one hands off | — | approved |
| R6 | Refactor [readability] | The "standing protocol" becomes the **reply format** (`REPLY_FORMAT`) | Says what it is: how a reply is read | — | approved |
| M11 | Model change | A **job** is one lane's agent's stretch of work on a todo, made of runs: a view over history and runs | Arrival, touched, attempts and finished here become facts about one job | — | approved |
| F3 | Feature | A requested run that cannot start says why on the card | A run request gets round nothing, so the card should say what it waits on | — | approved |
| T1 | Test [pin] | Pin how a finished run is read and routed | Protects A2 | — | done |
| T2 | Test [pin] | Pin the order of the system prompt's layers | Protects A3 | — | done |
| A1 | API change | Drop contracts, lane prompts and presets from the database | M1, M2 | T1 | done |
| A2 | API change | The server reads every finished run the same way | M1–M3 | T1 | done |
| A3 | API change | The runner sends one standing protocol | M1 | T2 | done |
| A6 | API change | Column enums (run status, kind, verdict; note kind; actor kind; draft role; artifact source and action) become GraphQL enums, SCREAMING_CASE on the wire | The API says which values exist; ArtifactInput and DraftTurn share the generated enums | drizzle-graphql#178 | blocked |
| A7 | API change | `RunEventInput.kind` becomes an enum | The runner already types it closed | — | proposed |
| R7 | Refactor [simplify] | Error helpers (`notFound`, `badInput`, `conflict`) in one module | 85 inline `new GraphQLError` across 24 files; `badInput` is already redefined locally | — | proposed |
| R8 | Refactor [simplify] | One `loadOwned*` family | `loadOwnedTodo`, `loadOwnedLane`, `loadOwnedProject`, `loadAiProject`, `loadAiTodo` repeat the fetch-and-404 | R7 | proposed |
| R9 | Refactor [types] | Attach resolvers through the generated `Resolvers` map, not `getType() as GraphQLObjectType` | 33 casts go; resolver args and parents are checked against the schema | — | proposed |
| R10 | Refactor [types] | Retire `AnyRow`/`AnyDb = any` (39) for drizzle's inferred types | Row shapes are checked | drizzle 1.0 typing (unverified) | proposed |
| R11 | Refactor [readability] | The server's internal `LaneTally` (projectId, laneId, done) gets its own name | It shares a name with the API's `LaneTally`, a different shape | — | proposed |
| R12 | Refactor [structure] | Group `server/src` by domain (runs, drafts, agents, board) instead of `resolvers/` vs root | A change to one area stays in one folder | — | proposed |
| R13 | Refactor [structure] | Weigh GraphQL Yoga against Apollo Server 5 | (unverified) smaller server, built-in subscriptions | — | proposed |
| F1 | Feature | The app sets a lane's agent with no station, preset or contract | M2, M3 | A2 | done |
| F2 | Feature | New agents start from starter text | M4 | — | done |
| R1 | Refactor [readability] | Retire "station" from code names | M3 | A2 | done |
| R2 | Refactor [readability] | One word, "route", for success and failure routes | Glossary | — | done |
| R3 | Refactor [readability] | The runner's `Brief` becomes `Assignment` | "Brief" means only the todo's brief | — | done |
| D1 | Docs | AGENTS.md and README.md describe the agent model | Docs match code | R1 | done |
| D2 | Docs | AGENTS.md links the domain model's glossary instead of defining the same terms in its rules | One definition per term | — | open |
| R4 | Refactor [readability] · low value | "Request" means four things; rename three | Glossary | A5 | open (A5 takes the AI actor's; run request, draft's rough request and the form's group remain) |

Status is `open`, `proposed`, `approved`, `declined` or `done`.

## Model changes

The domain model describes the code as it is, so a change waits here until the commit
that makes it true writes it into `.agents/domain-model.md`.

### M1 — Merge: one outcome rule for every run

Retire **contract**: the agent replies however it likes; a reply that starts with `FAIL`
fails, one that starts with `PASS` passes (both saved as a verdict note), anything else is
a report and passes. New todos may come from any run, in a fenced `todos` JSON block.
Status: done (later extended with refine and split outcomes, on `fix/planner-outcomes`).

### M2 — Move: the agent is the reusable part

Retire **lane preset**, **job**, and the **lane prompt**: what a lane asks for is its
agent's instructions. Status: done.

### M3 — Delete: "station"

Retire **station** as a word and as a code concept: "a lane with an agent". Status: done.

### M4 — Delete: agent templates

Retire **agent template** as a concept: it becomes starter text in the new-agent form.
Status: done.

### M5 — Name: the umbrella

As-is: a split todo depends on its pieces and stays in its lane; once they finish it is
ready again, and only the arrival rule stops its lane's agent re-working it. A person
moving it back in re-plans it. To-be: a split sets `todos.split_at`, and the todo is an
**umbrella**. An umbrella is never ready for an agent (`readyTodos` adds
`t.split_at IS NULL`), has no blocker edges to its pieces, shows as a group card with
progress (n of m pieces done) and an `aiStatus` of `waiting`, and completes itself, as
`system`, when its last unarchived piece completes (moved to the done lane, and archived
if it was split in an `archiveOnSuccess` lane). It reopens if a piece reopens or a new
piece is added. A person can dissolve it (`unsplitTodo`), which makes it an ordinary todo
again. Why it is simpler: "waits on its pieces" becomes a state with a name, instead of
blocker edges plus a rule about arrival. One migration column. Built: a trigger settles
the umbrella, so it closes and reopens however its pieces are written; it reopens into the
first open lane, stays archived once archived, and cannot be completed by hand while a
piece is open (unsplit it to finish it alone). Existing split parents were backfilled from
their "Split into" report notes, and their blocker edges dropped. Status: done (the parent
closes when its last piece does, not at split time).

### M6 — Introduce: lane roles

As-is: every lane accepts every outcome, so a planning lane's agent that does the work
passes like one that planned. To-be: `lanes.role` is `plan`, `work`, `review` or null.
`plan` accepts refine and split; `work` accepts report, split and fail; `review` accepts
pass and fail; null accepts everything, as today. An outcome the lane does not accept is
a failure with a reason the agent sees on its next attempt. The runner sends each role
its own standing protocol, naming only the outcomes it accepts. Pieces of a todo split in
a `plan` lane go to its success route. Board templates set roles. Why it is simpler: the
lane, not the agent's prompt, says what kind of answer counts, and the prompt and the
rule cannot disagree. Needs M5. Status: declined (the agent's instructions say what it
does; lanes stay role-free).

### M7 — Extend: a refine sets dependencies

As-is: a refine rewrites title, brief and acceptance; an agent cannot make its own todo
wait on another, or drop a blocker, except by splitting. To-be: the `refine` block takes
`dependsOn`, the full list of todos its todo waits on, by id, each one the run can see on
its own board. `finishRun` applies it with `setTodoDependencies`, so the cycle check
holds; a list that would cycle or names a todo out of reach fails the run with a reason
the agent sees next attempt. Omitted means unchanged, as with the other fields. A refine
is a success, so the todo takes the success route even when it now waits on an open
dependency, and is blocked in the next lane (never moved into the done lane while blocked,
as today). There are no lane roles (M6 declined), so any lane's agent may refine; its
instructions say whether it should (the Planner template does, Worker and Reviewer do not).
A worker that finds its todo cannot be done fails it with the reason;
the lane's failure route can point back at a plan lane, whose agent gets that reason as
"why it came back" in its assignment and can set the dependencies then. Why: planning is deciding what a todo is and what it waits on; both then go
through the one outcome path. Status: approved.

### M8 — Merge: one rule for moving blocked work

As-is: `moveTodo` refuses to move a blocked todo to any other lane, while a route
(`moveOn`) carries one to any lane but the done lane. To-be: one rule for every actor: a
blocked todo can move between open lanes and can never enter the done lane or be archived
on success. `moveTodo` keeps its `assertNotBlocked` check for the done lane only. Why it is
simpler: one rule where there were two, and a person can drag a todo that now waits on
something back to planning. Status: approved.

### M9 — Rename and merge: handed back

As-is: `aiStatus` `attention` means the lane's agent gave up (failures since touched over
`maxAttempts`) or finished with it and has nowhere to send it; the activity page's
`accountAttention` and the sidebar count mean something else: out of attempts, or its last
run errored. To-be: the state is **handed back**, with its reason (gave up after n
attempts; finished, nowhere to send it), and the activity page and sidebar count list
exactly the handed-back todos. A todo whose last run errored but has attempts left is
**failing**, not handed back; whether the activity page keeps a quieter failing list is
decided when this is built. Parked stays: nothing will work it because of how things are
set up, not because of what its runs did. The name may be refined later. Built: no failing
list, since a card already marks a failed run and its agent tries again; the API names
changed as a breaking change. Status: done.

### M10 — Rename and delete: agent templates

As-is: the new-agent form offers **starters** (Refiner, Planner, Worker, Reviewer) from
`app/src/lib/agent-starters.ts`. To-be: they are **agent templates** (`agent-templates.ts`),
still only starting text in the form, not saved rows (M4 stands); Refiner goes, since the
Planner refines. Status: approved.

### M11 — Name: the job

As-is: a run is one agent's go at a todo; whether a lane works the todo again, how many
attempts it has used and whether it is finished there are four queries over history
(`arrivedIn`, `TOUCHED`, `failuresSinceTouched`, `finished_here` in `ready.ts`). To-be: a
**job** is a lane's agent's stretch of work on a todo, from the todo arriving in the lane,
or a person's retry or run request there, until the todo leaves the lane or is handed back.
A job is made of **runs** and ends **passed**, **failed** (routed on its failure route),
**gave up** or **finished** (nowhere to send it); an open job has no ending yet. It is a
database view over `todos_history` and `runs`, so the triggers and `finishRun` stay its
only writers. Then: attempts are the job's failed runs; a lane works a todo only while
its job is open; handed back is a job that ended gave up or finished with the todo still
in the lane. A person's edit does not start a job (as an edit is not an arrival), so it
no longer resets attempts: retry is how a person gives an agent another go. So after a
person saves an edit, the app asks whether to start a new job, when the todo's lane has an
agent that could work it (every AI switch on, not hands off) and its job has ended or has
failed runs; yes is a retry. No dialog while a run holds it or its job is open and clean. The hook
session (`todo_sessions`, one per agent per todo) stays apart, so an agent's servers keep
their context across its jobs on a todo. A table written in one place (`jobs.ts`) is the
next step if the view is too slow or the UI needs to store something on a job.
Status: approved.

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

### F3 — A waiting run request says what it waits on

As-is: a todo with a run request shows "Waiting for an agent" (`board-card.tsx`) whatever
holds it up. To-be: the card names it, from the same reason `workStates` gives: blocked by
<todo>, the lane is at its WIP limit, an AI switch is off, the agent is switched off. A run
request still gets round none of these. Status: approved.

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

**Status:** done (`Assignment`, `RunAssignment`, `RunClaim.assignment`, `assignmentFor`, `assignmentPrompt`).

**Files:** `runner/src/telos.ts`, `prompts.ts`, `execute.ts`; server's claim type in
`runs.ts:91`. "Brief" stays for the todo's brief only. GraphQL type rename is part of A2's
breaking change, so it costs no extra release.

### A6, A7, R7–R13 — From the server cleanup review (2026-10-16)

Raised while moving hand-written enums into GraphQL (`server/src/enums.ts`) and
replacing hand-written API interfaces with `server/__generated__/resolvers.ts`.
Out of that branch's scope; one line each in the summary.

- **A6:** drizzle-graphql names a column enum's values by the raw value, so they would
  be lowercase on the wire. The upstream proposal for an `enumValueNameMapper` is
  cubicecho/drizzle-graphql#178. Until then those fields stay `String`.
- **R9:** codegen's `typescript-resolvers` output is now imported for input and
  output types. R9 is the next step: wire resolvers through its `Resolvers` map,
  with mappers for parents that are DB rows.

---

## Docs

### D2 — AGENTS.md points to the glossary

**File:** `AGENTS.md`, "Rules that carry weight". The rules define lane, run, arrival,
run reach and actor in passing, as the domain model does. Link the glossary near the top
of that section and drop definitions the rules don't need, keeping each rule's how.

### D1 — AGENTS.md and README.md say the new model

**Status:** done with R1.

**Files:** `AGENTS.md` (stations, contracts, presets: about 30 lines), `README.md` (AI section).
Rewrite with the glossary and the explain-test paragraph. Last, after the code.

---

## Low value / later

### R4 [readability] — "request" means four things

`runRequestedAt`, `submitRequest`, the draft's "rough request", the agent form's
"Requests" group. Out of this PR's scope; rename separately if wanted.
