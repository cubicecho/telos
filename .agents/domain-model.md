# Domain model

What telos is made of: its concepts, who may change them, and what always holds. This file
describes the code **as it is on this branch**. Proposed changes are `M` items in
`.agents/coding-standards-todos.md` and in the pull request that makes them; the commit
that makes one true writes it in here. Use these terms in code, tests, docs and reviews.
AGENTS.md says how each rule is built; this file says what the things are.

## Purpose

A self-hostable todo app: people keep todos in projects, and agents they set up work the
todos in the lanes they are given, through the same API a person or an MCP client uses.

## Flow

```
person / API key → todo in a lane → (lane has an agent, todo is ready) → claim → run
  → agent replies → finishRun applies the outcome → todo moves on a route, or stays
person → draft ⇄ agent → todo
```

The runner knows only the server's HTTP API; the server never knows how a runner works.
An agent knows nothing of lanes: the lane decides which agent works its todos and where
they go next.

## Actors

| Actor | Is | Reaches telos through | May change |
|---|---|---|---|
| `user` | A signed-in person | A session on `/graphql` | Everything they own, including every switch, agent, key, lane and MCP server |
| `apiKey` | An MCP client acting for a person | `/mcp` (or `/graphql`) with an API key | `AI_MUTATIONS` on projects and todos AI can see, less the tools its owner switched off (`door.ts`) |
| `agent` | A run, while it is live | `/mcp` with the run token | Notes on its own todo; the todos under it and those its todo's runs made, in its own project (`run-reach.ts`). Its own todo only through its reply's outcome, which `finishRun` applies: a refine rewrites title, brief and acceptance. Never its own todo's lane, completion or dependencies directly |
| `system` | The runner, or the server itself | `x-runner-key` | `RUNNER_MUTATIONS` only: claim, heartbeat and finish a run or a draft's reply |
| `anonymous` | Nobody signed in | — | Sign-in only |

`apiKey` and `agent` are the **AI actors** (`isAiActor`): they see only projects with AI on
and todos not marked hands off, and every AI switch above them must be on.

## Lifecycles

### Todo: where it is

```
create (in a lane) --move--> another lane --move into done lane / complete--> done
done --move out / reopen--> open
any --deleteTodo--> archived --restoreTodo--> back in its lane
any --deleteTodo(hard: true)--> gone (sessions owed a sessionDelete, artifacts detached)
```

Every change is a **history event**, written by the `todos_history` trigger: `create`,
`move`, `complete`, `reopen`, `edit`, `retry`, `run`, `archive`, `restore`. Several changes
in one transaction are one event.

- **Arrival:** the latest non-`edit` event that put the todo in its lane, else its
  creation (`arrivedIn` in `server/src/ready.ts`). Work since arrival counts; an edit is
  never an arrival.
- **Touched:** a person's event, or a `retry` or `run` event. It resets the attempt count
  (`TOUCHED`, `failuresSinceTouched` in `ready.ts`).

### Todo: what agents make of it (`aiStatus`)

Checked in this order; the first that holds wins (`workStates` in `ready.ts`, the same
rules `readyTodos` filters by):

1. `running`: a run holds it.
2. `parked`: nothing will work it where it is: no lane, hands off, no agent, or the agent
   switched off.
3. `attention`: more failed runs since it was touched than the lane's `maxAttempts`, or an
   `ok` run in this lane since it arrived and nowhere to send it (**finished here**).
4. `blocked`: it waits on an open dependency.
5. `parked` again: auto-run is off and nobody asked for a run.
6. `queued`: the lane's agent will start on it when there is room.

Done todos are counted per lane, not listed. The activity page's `accountAttention` is a
different rule with the same name: out of attempts, or its last run errored.

### Run

```
claim --> running --heartbeat...--> ok | error | stopped
```

A run of a todo ends with a verdict `pass`, `fail` or `none`. A lapsed lease frees the todo;
a stop request (a switch turned off, `cancelRun`) is answered on the next heartbeat, and a
stopped run writes nothing. `finishRun` turns the reply into one **outcome** and applies it:

| Outcome | Reply | Applied as |
|---|---|---|
| ruling | Opens with `PASS` or `FAIL` | Success or failure route; a verdict note |
| report | Anything else | As a pass; a report note |
| refine | A fenced `refine` block, or a `todos` block of one | Rewrites title, brief, acceptance (what it omits stays), then as a pass |
| split | A fenced `todos` block of two or more | Pieces filed under the todo, which waits on them where it is |
| error | The run failed, or a reply both refines and splits | Failure route; counts an attempt |

### Run request

`runTodo` sets it; the claim, or the todo moving, finishing, being archived or marked
hands off clears it. It asks for one run where the todo stands and gets round nothing:
not the AI switches, a blocker or the WIP limit.

### Draft

```
person says something --> waiting --agent's reply (a draft run)--> answered --...--> made into a todo
                                                                          \--> discarded
```

## Invariants

| Invariant | Enforced by |
|---|---|
| Every table is scoped to its owner | `scope` in `server/src/tenancy.ts`; `tenancy.test.ts` |
| A todo with a lane is complete if and only if the lane is the done lane | `server/src/lanes.ts`, `assertCompletionMatchesLane` |
| At most one done lane per project; every project has a lane | `uq_lanes_project_done`; `seedMissingLanes`, last-lane delete refused |
| A blocked todo is never completed or archived on success | `assertNotBlocked`, `assertNoBlockedCompletions`; `moveOn`, `archiveOn` in `runs.ts` |
| A person cannot move a blocked todo to another lane; a route can, to any lane but the done lane | `moveTodo` in `server/src/resolvers/lanes.ts`; `moveOn` in `runs.ts` |
| Dependencies have no cycles | `assertNoCycle`, the only way in being `addTodoDependency` / `setTodoDependencies` |
| One running run per todo, and per draft | `uq_runs_todo_running`, `uq_runs_draft_running` |
| Only `finishRun` changes a run's own todo | `server/src/resolvers/run-reach.ts` |
| A todo is refined or split, never both | `finish` in `server/src/resolvers/runs.ts` |
| A lane archives on success or has a success route, not both | `assertArchiveOnSuccessFits` |
| History and the change feed are written by triggers only | `todos_history`, `change_log` triggers; no CRUD on either |
| A report or verdict note is never changed | `server/src/resolvers/notes.ts` |
| AI sees nothing in a project with AI off, or under a hands-off todo | `tenancy.ts`, `ai-reach.ts`, `visibleToAi` |
| Every AI switch must be on for any agent to run | `readyTodos`, `ai-gate.ts`, `resolveActor` |

## Glossary

### Places

- **Account (user):** owns everything below it; has an AI switch and agent defaults.
  Owner: `users`.
- **Instance:** one telos deployment; has the instance AI switch, flipped by an admin.
  Owner: `server/src/instance.ts`.
- **Project:** holds lanes and todos; has an AI switch, **auto-run**, a
  description and context sent to every run, and a new-todo lane. Owner: `projects`.
- **Lane:** a column of a project. It may have an agent, routes, a WIP limit and max
  attempts. Owner: `server/src/lanes.ts`.
- **Done lane:** the one lane per project where todos are complete.
- **New-todo lane:** where requests, drafts made into todos and split pieces land:
  `projects.newTodoLaneId`, else the first open lane (`findNewTodoLaneId`). Pieces of a
  todo split *in* this lane go on down its success route instead, unless that is the done
  lane (`piecesLaneId`).
- **Route:** where a todo goes when its run passes (**success route**, or archive on
  success) or fails (**failure route**). With no route it stays.
- **Board template:** a saved set of lanes for starting a project.

### Work

- **Todo:** one piece of work: title, **brief** (the `notes` column), **acceptance** (what
  done means, and what an agent is judged against), due date, position. Owner: `todos`.
- **Dependency (blocker):** "this todo waits on that one". Owner: `server/src/blocking.ts`.
- **Parent / piece:** `parentId`: the todo a piece was split out of, or that someone filed
  it under. A split parent depends on its pieces.
- **Request:** a todo an AI actor filed for a person (`submitRequest`), withdrawable with
  `cancelRequest`. The word also means other things in the code: a run request
  (`runRequestedAt`), a draft's "rough request", the agent form's "Requests" group.
- **Draft:** a conversation with an agent that becomes a todo (`makeTodoFromDraft`).
  Owner: `server/src/resolvers/drafts.ts`.
- **Archive:** put away, not gone: what `deleteTodo` does. Hidden from reads, restorable;
  only `deleteTodo(hard: true)` removes the row (`archivedAt`).
- **Hands off:** `aiIgnored`. No agent reads or works the todo; only a person sets it.
- **Label:** a coloured tag on a todo or a project.

### What happened

- **Thread:** a todo's notes, each a **note** (a person's or an agent's), a **report**
  (what a run said it did) or a **verdict** (a PASS or FAIL). Owner: `todo_notes`.
- **History event:** see the todo's lifecycle. Owner: the `todos_history` trigger.
- **Arrival, touched:** see the todo's lifecycle. Owner: `server/src/ready.ts`.
- **Attempt:** a failed run since the todo was last touched. At `maxAttempts` it is left
  for a person.
- **Artifact:** a file or link a run (`declared`, `detected`) or an MCP client (`client`)
  recorded making. Outlives its todo. Owner: `artifacts`.
- **Change feed:** `changes(since:)`, what changed in a project since a cursor. Owner:
  `server/src/changes.ts`.

### Agents and runs

- **Agent:** a model, its instructions, its MCP servers and tool switches; a blank field
  inherits the account's **agent defaults**. It has no idea of lanes. Owner: `agents`,
  `server/src/agent-defaults.ts`.
- **Starter:** starting text for a new agent: Refiner, Planner, Worker, Reviewer
  (`app/src/lib/agent-starters.ts`).
- **MCP server:** an account's tool server; an agent names which it reaches by slug.
  Owner: `server/src/mcp-servers.ts`.
- **Runner:** works ready todos and drafts over HTTP as `system`. Owner: `runner/`.
- **Ready:** a todo the runner would take now (`readyTodos`). Owner: `server/src/ready.ts`.
- **Claim, lease, heartbeat:** taking a ready todo, holding it for a time, renewing that.
- **Run:** one agent working one todo (`kind = 'todo'`) or answering a draft
  (`kind = 'draft'`). Owner: `server/src/resolvers/runs.ts`.
- **Run token, run reach:** what a run's `/mcp` calls may touch (see Actors).
- **Assignment:** what a run is handed: project text, the todo, its last report, why it
  came back, its thread (`assignmentFor`).
- **Standing protocol:** how every reply is read, sent after the agent's instructions
  (`STANDING_SYSTEM` in `runner/src/prompts.ts`).
- **Outcome:** what a reply amounts to; see the run's lifecycle. Owner: `finish` in
  `server/src/resolvers/runs.ts`.
- **Session:** a todo as an agent's MCP hooks see it, one per agent per todo; a run is a
  turn of it. Owner: `todo_sessions`.

## Explain test

A person keeps todos in the lanes of a project. A lane with an agent works each todo that
is ready in it: the runner claims it and the agent gets an assignment, with the standing
protocol. Its reply is one outcome, a ruling, a report, a refine or a split, and only
`finishRun` applies it to the todo, which then takes the lane's success or failure route,
or waits where it is on its pieces. The todo's history says when it arrived in its lane,
and work since then is not repeated. People and API keys change todos directly within
their reach; a run changes the todos it made freely, and its own todo only through its
outcome, and AI sees nothing its owner has switched off or marked hands off.
