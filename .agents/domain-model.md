# Domain model: todos, lanes and agents

A proposal, plus the glossary it rests on. Steps 1–3 of the order of work
below have shipped; **(new)** marks a term or rule from steps 4–5 that does not
exist yet. Everything else describes the code as it stands.

## The principle

A todo's behaviour belongs to the server. An agent never changes its own todo.
It returns an **outcome**, and `finishRun` applies it according to the lane's
**role**.

Today that holds for moves, completion and dependencies (`run-reach.ts`), but
not for text: a run may `updateTodo` its own todo. Nothing types the reply
either. Any reply that is not FAIL passes, so a planner that does the work, or
rewrites the todo and then also splits it, looks to the server just like one
that planned. The proposal closes both gaps:

1. **Outcomes are typed.** A reply is one of pass, fail, report, refine or split.
   The runner parses it, and only `finishRun` acts on it.
2. **A lane's role says which outcomes it accepts.** An outcome a lane does not
   accept is a failure, with a reason the agent sees on its next attempt.
3. **A split turns the todo into an umbrella.** No agent works it again. It
   completes when its pieces do.
4. **Arrival means arrival.** Editing a todo is not arriving in a lane, so it
   cannot re-queue work that is already done.

Agents still "exist" as they do now: a model, a persona and some tools, and any
agent can sit in any lane. The lane, not the agent, decides what kind of
answer counts.

## Why it misbehaved (fixed by steps 1–3)

- **The planner is offered the wrong outcomes.** `STANDING_SYSTEM` gives two
  choices: report what you did, or propose a `todos` block. Rewriting the todo
  is not one of them, so the planner either does the work, which passes and
  moves the todo on, or proposes a single cleaner copy, which becomes a child.
  The Planner starter's "one is a fine answer" makes the copy more likely.
- **Re-planning comes from a bug in arrival.** `readyTodos` does not re-run a
  todo that already has an `ok` run in its lane since it *arrived*
  (`ready.ts`, around line 115). Arrival is read as the latest `todo_events`
  row with `to_lane_id = lane`, and the history trigger stamps `to_lane_id` on
  *every* event, edits included (`richer_todos` migration, `record_todo_event`).
  So when a planner calls `updateTodo` on its own todo mid-run (which is
  allowed), or a person edits the parked parent later, that edit counts as a
  fresh arrival. Once the children finish and the parent unblocks, the planner
  gets it again. The `why` in `assignmentFor` has the same mistake: an edit can
  pose as "why it came back".
- **The pieces land back in the planning lane.** Children go to the new-todo
  lane, which on a plan → work → review board is usually the planning lane. So
  every piece is planned a second time and may be split again.
- **A run's MCP `createTodo` is a split nobody records.** The todos it creates
  have no `parentId` and no dependency, and the parent passes and moves on.

## Proposal

### Outcomes (shipped, without roles)

The runner parses a reply into exactly one outcome:

| Outcome | Reply | What `finishRun` does |
|---|---|---|
| **pass** | opens with `PASS` | Takes the success route, or archives (`archiveOnSuccess`) |
| **fail** | opens with `FAIL`, or the run errored | Takes the failure route and counts an attempt |
| **report** | anything else | The same as pass; the reply goes on the thread as a report |
| **refine** | a fenced `refine` block: `title`, `brief`, `acceptance` | Rewrites the todo, then as pass |
| **split** | a fenced `todos` block with two or more items | Writes the pieces and makes the todo an umbrella (below) |

A one-item `todos` block is read as a refine. Mixing a `refine` block with a
`todos` block is a fail ("a todo is either refined or split").

### Lane role (new)

`lanes.role`: `plan | work | review | null`. It decides two things: which
outcomes count, and which standing protocol the runner sends. The agent is
told only about the outcomes it can use, so the prompt and the rule cannot
disagree.

| Role | Accepts | A reply it does not accept |
|---|---|---|
| `plan` | refine, split | report/pass → fail: "a planning lane rewrites or splits the todo; it does not do the work" |
| `work` | report, split, fail | (all are fine) |
| `review` | pass, fail | refine/split → fail |
| `null` | everything, as today | none |

`null` keeps every existing board working. Board templates set the role.

### Split → umbrella (new)

On a split, `finishRun`:

1. Writes the pieces with `parentId` set to the todo, linking them to each
   other through `dependsOn` as now.
2. Puts the pieces where the todo would go next. Shipped so far
   (`piecesLaneId`): pieces go to the new-todo lane, except that a todo split
   *in* the new-todo lane sends them on down its success route, unless that is
   the done lane. With roles, a `plan` lane's success route.
3. Sets `todos.split_at` on the parent. The todo is now an **umbrella**.
4. Writes **no** dependency edges from the parent to its pieces. The umbrella
   waits on its pieces because it is an umbrella, not because of blockers, so
   the board's blocker lines show real ordering only.

An umbrella:

- is never ready for an agent (`readyTodos` adds `t.split_at IS NULL`);
- stays in its lane and shows as a group card with progress (n of m pieces done);
- completes itself, as `system`, when its last unarchived piece completes.
  It is moved to the done lane, and archived if it was split in an
  `archiveOnSuccess` lane. The same trigger or resolver that completes pieces
  checks this, so it holds however a piece is completed;
- reopens if a piece is reopened (or a new piece is added under it), the same
  way a parent with a reopened child should be honest about it;
- can be **dissolved** by a person (`unsplitTodo`): `split_at` is cleared and
  it is an ordinary todo again. That is how someone says "plan this again".

`aiStatus` gets a `waiting` state for umbrellas, separate from `blocked`.

### Arrival (shipped)

Arrival is an event with `to_lane_id = lane` **and** `kind <> 'edit'`, i.e. a
create, move, reopen, restore, retry or run. It is defined once, as `arrivedIn`
in `ready.ts`, and used by `readyTodos`, `workStates`, `retention.ts` and
`assignmentFor`'s `why`. This alone stops a split parent being re-planned after
an edit.

### What a run may write (shipped)

- A run no longer edits its own todo's text. A refine outcome replaces that.
  Notes on its own todo stay allowed.
- `createTodo` from a run is off by default (`RUN_DEFAULT_WRITES`), because pieces of
  the run's own todo come back as a split. An agent whose job really is to
  file unrelated todos (a triage agent) can have it switched on, and what it
  creates is filed as it is now.

### The Planner starter (shipped, in `agent-starters.ts`)

> Your job is to make this todo ready for one person to do in one sitting.
> If it already is one piece of work, rewrite it in a `refine` block: a clear
> title, a brief that says what to change and where, and acceptance someone
> could check. If it is genuinely several pieces of work, split it into a
> `todos` block of two or more. Never do the work yourself.

### Order of work

1. The arrival fix, with a test: a split parent that someone edits is not
   re-queued.
2. Pieces land at the success route, not the new-todo lane.
3. Outcomes and the `refine` block in the runner and `finishRun`. Close
   own-todo text edits in `run-reach.ts`.
4. Umbrellas: `split_at`, `readyTodos`, auto-complete, the `waiting` state and
   the group card.
5. `lanes.role` and per-role standing protocols, set by board templates.

Steps 1–3 fix both reported problems and need no migration. Step 4 adds one
column, and step 5 one more.

## Glossary

### Places

- **Instance:** one telos deployment. It has the instance AI switch.
- **Account (user):** owns everything below it, and has its own AI switch and
  agent defaults.
- **Project (board):** holds lanes and todos. It has its own AI switch,
  **auto-run**, a description and context sent to every run, and a
  **new-todo lane**.
- **Lane:** a column on a board. It may have an agent, routes, a WIP limit,
  max attempts and a **role (new)**.
- **Done lane:** the one lane per project where todos are complete. Moving a
  todo in completes it; moving it out reopens it.
- **New-todo lane:** where requests, finished drafts and split pieces land:
  `projects.newTodoLaneId`, else the first open lane. Pieces of a todo split
  in this lane go on down its success route instead.
- **Route:** where a todo goes when its run passes (success route) or fails
  (failure route). With no route, it stays.
- **Lane role (new):** `plan`, `work`, `review` or none. Decides which
  outcomes count in the lane.

### Work

- **Todo:** one piece of work. Its fields:
  - **title**;
  - **brief** (the `notes` column);
  - **acceptance**, what done means and what an agent is judged against;
  - **due date**;
  - **position**.
- **Dependency (blocker):** "this todo waits on that one". A **blocked** todo
  can neither be completed nor change lane.
- **Parent / piece:** `parentId`. The todo a piece was split out of, or that
  a person filed it under.
- **Umbrella (new):** a todo that was split (`split_at`). No agent works it.
  It completes when its pieces do.
- **Request:** a todo an AI filed for a person to see (`submitRequest`). A
  person can withdraw it with `cancelRequest`.
- **Draft:** a conversation with a refiner agent that becomes a todo
  (`makeTodoFromDraft`).
- **Board template:** a saved set of lanes (and, with step 5, their roles)
  for starting a board.
- **Archive:** put away, not deleted. Hidden from reads, and can be restored.
- **Hands off:** `aiIgnored`. No agent reads or works the todo. Only a person
  can set it or clear it.

### What happened

- **Thread:** a todo's notes. A note has a kind:
  - **note**, written by a person or an agent;
  - **report**, what a run said it did;
  - **verdict**, a PASS or FAIL.
- **History (event):** written by a trigger, never by resolvers. Each event
  has a kind (create, move, complete, reopen, edit, retry, run, archive or
  restore), an **actor**, and a run when one made it.
- **Arrival:** the latest non-edit event that put the todo in its current
  lane. Work done "since arrival" counts. Work from before it is history.
- **Touched:** a person's event, or a retry or run event. It resets the
  failure count.
- **Actor:** who wrote something:
  - **user**;
  - **key**, an API key;
  - **agent**, a run;
  - **system**, the runner or the server itself.

### Agents and runs

- **Agent:** a model, its instructions (persona and job), its MCP servers and
  tool switches. A blank field inherits the account's **agent defaults**. An
  agent has no idea of lanes. The same agent can work any lane.
- **Starter:** the starting text for a new agent (refiner, planner, worker,
  reviewer).
- **Runner:** the process that takes ready todos, runs agents and reports back.
  It reads and writes only over HTTP, as `system`.
- **Ready:** a todo an agent would take now (`readyTodos`). All of these must
  hold:
  - AI is on at every level;
  - the project has auto-run on, or someone made a run request;
  - the todo is not done, archived, hands-off, blocked, an umbrella (new),
    already running, already worked since arrival, or over max attempts;
  - the lane is under its WIP limit.
- **Run request:** `runTodo`, which asks for one run where the todo stands.
  It is cleared by the claim, or by the todo moving.
- **Claim / lease / heartbeat:** a runner takes a ready todo and holds it for
  a lease, which it renews with heartbeats. A lapsed lease frees the todo.
- **Run:** one agent working one todo, or answering a draft. A run ends `ok`,
  `error` or `stopped`, with a **verdict** (pass, fail or none).
- **Run token / run reach:** what a run's MCP calls may touch: its own board,
  and its own todo with what sits under it. Its own todo it may only read and
  note; it rewrites it with a refine.
- **Assignment:** what a run is handed. That is:
  - the project text;
  - the todo's title, brief and acceptance;
  - its last report;
  - why it came back;
  - its notes.
- **Standing protocol:** how a reply is read, sent with every run after the
  agent's own instructions. With step 5, one protocol per lane role.
- **Reply → outcome:** pass, fail, report, refine or split. `finishRun`
  is the only thing that applies an outcome to the todo.
- **Attempt:** a failed run since the todo was last touched. Once `maxAttempts`
  is used up, it is left for a person.
- **Session:** a todo as seen by an agent's MCP hooks, one per agent per todo.
- **Artifact:** a file or link a run recorded making.
