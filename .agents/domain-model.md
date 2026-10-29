# Domain model

What telos is made of: its concepts, who may change them, and what always holds. This file
describes the code **as it is on this branch**. Proposed changes are `M` items in
`.agents/coding-standards-todos.md` and in the pull request that makes them; the commit
that makes one true writes it in here. The one exception is an approved rename: the
glossary uses the new word at once, and says what the code still calls it. Use these terms
in code, tests, docs and reviews. AGENTS.md says how each rule is built; this file says
what the things are. The glossary is also published as the site's glossary page.

## Purpose

A self-hostable todo app: people keep todos in projects, and agents they set up work the
todos in the lanes they are given, through the same API a person or an MCP client uses.

## Flow

```
person / API key → todo in a lane → (lane has an agent, todo is ready) → claim → run
  → agent replies → finishRun applies the outcome → todo moves on a route, or stays
```

The runner knows only the server's HTTP API; the server never knows how a runner works.
An agent knows nothing of lanes: the lane decides which agent works its todos and where
they go next.

## Actors

| Actor | Is | Reaches telos through | May change |
|---|---|---|---|
| `user` | A signed-in person | A session on `/graphql`, or an access token the OIDC provider issued for the API (a device app such as Home Assistant), mapped through the person's `accounts` row | Everything they own, including every switch, agent, key, lane and MCP server |
| `apiKey` | An MCP client acting for a person | `/mcp` (or `/graphql`) with an API key | `AI_MUTATIONS` (`graphql/permissions.ts`) on projects and todos AI can see, less the tools its owner switched off (`door.ts`) |
| `agent` | A run, while it is live | `/mcp` with the run token | Notes on its own todo; the todos under it and those its todo's runs made, in its own project (`run-reach.ts`). Its own todo only through its reply's outcome, which `finishRun` applies: a refine rewrites title, brief and acceptance. Never its own todo's lane, completion or dependencies directly |
| `system` | The runner, or the server itself | `x-runner-key` | `RUNNER_MUTATIONS` only: claim, heartbeat and finish a run |
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
2. `waiting`: it is an umbrella; done when its pieces are.
3. `parked`: nothing will work it where it is: no lane, hands off, no agent, or the agent
   switched off.
4. `handedBack`: more failed runs since it was touched than the lane's `maxAttempts`
   (`gaveUp`), or an `ok` run in this lane since it arrived and nowhere to send it
   (`finished`, **finished here**).
5. `blocked`: it waits on an open dependency.
6. `parked` again: the project does not run by itself (AI mode one lane, or follow and
   the todo not followed) and nobody asked for a run.
7. `queued`: the lane's agent will start on it when there is room.

Done todos are counted per lane, not listed. The activity page's `accountHandedBack` and
the sidebar count are the `handedBack` todos, by the same rule. A todo whose last run
failed with attempts left is not handed back: its agent tries again.

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
| split | A fenced `todos` block of two or more | Pieces filed under the todo, which becomes an umbrella where it is |
| error | The run failed, or a reply both refines and splits | Failure route; counts an attempt |

### Umbrella

```
split --> umbrella --last unarchived piece completes--> done (as `system`)
             ^                                            |
             \---a piece reopens, or a new one is filed---/
umbrella --unsplitTodo--> an ordinary todo
```

A split sets `todos.splitAt`. Its pieces settle it through the `todos_settle_umbrella`
trigger, as `system`: complete, it goes to the done lane, and is archived if the lane it
left archives on success; reopened, it goes to the first open lane. An archived umbrella
stays archived. No agent works it, and no dependency joins it to its pieces.

### Run request

`runTodo` sets it; the claim, or the todo moving, finishing, being archived or marked
hands off clears it. It asks for one run where the todo stands and gets round nothing:
not the AI switches, a blocker or the WIP limit.

## Invariants

| Invariant | Enforced by |
|---|---|
| Every table is scoped to its owner | the ability's row rules (`auth/rows.ts`), as `scope` in `graphql/tenancy.ts`; `tenancy.test.ts`, `row-reach.test.ts` |
| A todo with a lane is complete if and only if the lane is the done lane | `server/src/lanes.ts`, `assertCompletionMatchesLane` |
| At most one done lane per project; every project has a lane | `uq_lanes_project_done`; `seedMissingLanes`, last-lane delete refused |
| An umbrella is completed only by its pieces, while it has open ones | `todos_settle_umbrella`; `assertNotBlocked`, `assertNoBlockedCompletions` |
| A blocked todo is never completed or archived on success | `assertNotBlocked`, `assertNoBlockedCompletions`; `moveOn`, `archiveOn` in `runs.ts` |
| A person cannot move a blocked todo to another lane; a route can, to any lane but the done lane | `moveTodo` in `server/src/resolvers/lanes.ts`; `moveOn` in `runs.ts` |
| Dependencies have no cycles | `assertNoCycle`, the only way in being `addTodoDependency` / `setTodoDependencies` |
| One running run per todo | `uq_runs_todo_running` |
| Only `finishRun` changes a run's own todo | `server/src/resolvers/run-reach.ts` |
| A todo is refined or split, never both | `finish` in `server/src/resolvers/runs.ts` |
| A lane archives on success or has a success route, not both | `assertArchiveOnSuccessFits` |
| History and the change feed are written by triggers only | `todos_history`, `change_log` triggers; no CRUD on either |
| A report or verdict note is never changed | `server/src/resolvers/notes.ts` |
| AI sees nothing in a project with AI off, or under a hands-off todo | `aiReach` in `auth/rows.ts`, `ai/reach.ts`, `visibleToAi` |
| Every AI switch must be on for any agent to run | `readyTodos`, `ai-gate.ts`, `resolveActor` |

## Glossary

The words to use for telos, in code, docs and the app. The site's glossary page is built
from this section, so each entry is written for someone using telos: the definition, up
to `Owner:`, reads without code, and what follows `Owner:` says where it lives in the code.
An approved rename may lead the code; its `Owner:` then gives the code's current name and
the item that renames it. **Internals** are for people working on telos and are left off
the site.

### Places

- **Instance:** one telos installation. Its admin can switch AI off for everyone on it.
  Owner: `server/src/instance.ts`.
- **Account:** you, and everything you own. It has its own AI switch, the agent
  defaults new agents start from, its prompts, and the agent instructions every agent
  is told first whichever project it works in (a person edits them in Settings, and
  Reset goes back to the built-in default).
  Owner: `users`, `db/src/prompt-seeds.ts`.
- **Project:** a set of lanes and the todos in them. It has its own AI mode (off, auto, one lane or follow),
  a description every agent working in it is given, a prompt (standing instructions to
  those agents, a person's only), and a new-todo lane.
  Owner: `projects`.
- **Lane:** a column in a project. A lane can have an agent that works the todos in it,
  routes that say where they go next, a WIP limit and max attempts.
  Owner: `server/src/lanes.ts`.
- **Done lane:** the one lane in a project where todos are complete. Moving a todo into
  it completes the todo, and moving it out reopens it. Owner: `lanes.isDone`.
- **New-todo lane:** where a todo lands when nobody says where: one an agent or MCP
  client filed, and the pieces of a split. If none is set, the
  first open lane. Pieces of a todo split in this lane skip it and go on down its success
  route, unless that is the done lane. Owner: `projects.newTodoLaneId`,
  `findNewTodoLaneId`, `piecesLaneId`.
- **Route:** where a todo goes when its lane's agent is done with it: the success route
  after a pass, the failure route after a fail. A lane can archive todos on success
  instead. With no route, the todo stays where it is. Owner: `lanes.onSuccessLaneId`,
  `lanes.onFailureLaneId`, `lanes.archiveOnSuccess`.
- **WIP limit:** how many todos a lane's agent works at once. Owner: `lanes.wipLimit`.
- **Run limit:** how many runs the whole instance works at once, across every runner, lane and
  account; lanes' WIP limits apply under it. An admin sets it in Settings → Agents. Owner:
  `instance_settings.runLimit` (default 2).
- **Max attempts:** how many failed runs a lane's agent gets at a todo before it hands
  it back. Owner: `lanes.maxAttempts`.
- **AI mode:** how far AI works a project. Off: not at all. Auto: the lanes' agents start
  on ready todos by themselves. One lane: a todo runs only when someone asks for a run,
  and waits again in the next lane. Follow: a todo runs when someone asks, and from then
  on every lane it goes on to works it by itself. Owner: `projects.aiEnabled` and
  `projects.runMode`, set by `setProjectAiMode`.
- **Followed todo:** one asked for in a project in follow mode, until it is done, archived
  or ignored, or the project leaves follow mode. Owner: `todos.followedAt`.
- **Board template:** a saved set of lanes to start a project with.
  Owner: `board_templates`.

### Work

- **Todo:** one piece of work: a title, a description, acceptance, a due date and labels.
  Owner: `todos`.
- **Description:** what to do, and why. Owner: `todos.notes`, `brief` in the API and the
  runner (renamed by A4).
- **Acceptance:** what done means. An agent's work is judged against it.
  Owner: `todos.acceptance`.
- **Dependency (blocker):** "this todo waits on that one". While a todo it waits on is
  open, the todo is blocked: it cannot be completed, and no agent works it.
  Owner: `server/src/blocking.ts`, `todo_dependencies`.
- **Parent and piece:** a piece is a todo split out of a larger one, its parent, or one
  someone filed under it. Owner: `todos.parentId`.
- **Umbrella:** a todo split into pieces. No agent works it; it completes by itself when
  its last piece does, and reopens when a piece reopens or a new one is filed under it.
  You cannot complete it while pieces are open; unsplit it to finish it alone.
  Owner: `todos.splitAt`, the `todos_settle_umbrella` trigger, `unsplitTodo`.
- **Archive:** putting a todo away: hidden, not gone, and it can be restored. Deleting a
  todo archives it, unless you delete it for good. Owner: `todos.archivedAt`,
  `deleteTodo`, `restoreTodo`.
- **Hands off:** a todo no agent may read or work, nor anything under it. A person sets
  it; an agent or MCP client can set it too, with a reason, to give a todo back to you.
  Owner: `todos.aiIgnored`; `cancelRequest` (renamed `markHandsOff` by A5).
- **Label:** a coloured tag on a todo or a project. Owner: `labels`.
- **Run request:** asking for one run of a todo now. It waits like any other run: it does
  not get round an AI switch that is off, a blocker or the lane's WIP limit.
  Owner: `todos.runRequestedAt`, `runTodo`.
- **Retry:** giving a lane's agent another go at a todo it handed back; its failed runs
  stop counting. Owner: `retryTodo`.

### What agents make of a todo

- **Queued:** its lane's agent will start on it when there is room.
  Owner: `workStates` in `server/src/ready.ts`.
- **Running:** a run is working on it.
- **Waiting:** it is an umbrella, and is done when its pieces are.
- **Blocked:** it waits on an open dependency.
- **Parked:** nothing will work on it where it is: its lane has no agent, AI or the
  agent is switched off, it is hands off, or its project does not run by itself and nobody
  asked for a run.
- **Handed back:** its lane's agent is done with it and it cannot move on without you:
  the agent gave up after more failed runs than the lane's max attempts, or it finished
  and the lane has nowhere to send it. Owner: `aiStatus` `HANDED_BACK`, with `GAVE_UP` or
  `FINISHED`; the activity page's `accountHandedBack`.

### What happened

- **Thread:** a todo's notes, reports and verdicts, oldest first. Owner: `todo_notes`.
- **Note:** something a person or an agent wrote on a todo's thread.
- **Report:** what a run said it did. Never changed afterwards.
- **Verdict:** a run's PASS or FAIL, with its reasons. Never changed afterwards.
- **History:** every change to a todo: what changed, who changed it and why.
  Owner: the `todos_history` trigger, `todo_events`.
- **Attempt:** a failed run since a person last changed the todo, retried it or asked
  for a run. Owner: `failuresSinceTouched` in `server/src/ready.ts`.
- **Artifact:** a file or link a run or an MCP client recorded making. It outlives its
  todo. Owner: `artifacts`.

### Agents and runs

- **AI switches:** the instance's, the account's, the project's and each agent's. Every
  one above an agent must be on for it to run. Owner: `ai-gate.ts`, `readyTodos`.
- **Agent:** a model with a prompt, the MCP servers it may use and the tools it may
  call. A setting left blank uses the account's agent defaults. An agent knows nothing
  of lanes: a lane is given an agent. Owner: `agents`, `server/src/agent-defaults.ts`.
- **Prompt:** what one kind of agent is told to do, chosen by each agent. Every account
  starts with Planner, Reviewer and Worker, which a person may edit, delete or add to.
  A person's only.
  Owner: `prompts`, `db/src/prompt-seeds.ts`.
- **MCP server:** a tool server added to an account; each agent names the ones it may
  use. Owner: `server/src/mcp-servers.ts`.
- **MCP client:** an assistant connected to telos with an API key, working in the
  projects and todos AI may see. Owner: `/mcp`, `server/src/door.ts`.
- **Runner:** the program that starts runs: it takes ready todos and runs
  their agents. Owner: `runner/`.
- **Run:** one go by an agent at a todo, ending in a reply.
  Owner: `runs`, `server/src/resolvers/runs.ts`.
- **Reply format:** the rules a run's reply is read by. They are not sent as a fixed
  protocol: each seeded prompt asks for the shape its kind of agent is read in, and the
  agent instructions hold the rest.
  Owner: `readReply` in `runner/src/prompts.ts`, `verdictOf` in the runs resolvers.
- **Outcome:** what a reply comes to: a verdict, a report, a refine or a split. A run
  that fails or breaks the reply format is an error, and counts as an attempt.
  Owner: `finish` in `server/src/resolvers/runs.ts`.
- **Refine:** a reply that rewrites its todo's title, description or acceptance; what it
  leaves out stays. The todo then takes its success route. Owner: `refinementOf`.
- **Split:** a reply that breaks its todo into two or more pieces. The todo becomes an
  umbrella where it is. Owner: `finish`, `piecesLaneId`.

### Internals

- **Actor:** who is making a change: a person (`user`), an API key, a run (`agent`), the
  runner (`system`) or nobody. Owner: `Actor` in `server/src/context.ts`.
- **AI actor:** an API key or a run. Owner: `isAiActor` in `server/src/context.ts`.
- **Ready:** a todo the runner would take now. Owner: `readyTodos` in
  `server/src/ready.ts`.
- **Arrival:** the latest change, other than an edit, that put a todo in its lane, or its
  creation. Work since arrival counts. Owner: `arrivedIn` in `server/src/ready.ts`.
- **Touched:** a person's change, a retry or a run request; it resets attempts. Owner:
  `TOUCHED` in `server/src/ready.ts`.
- **Finished here:** an `ok` run in the todo's lane since it arrived, with nowhere to
  send it. Owner: `finished_here` in `workStates`.
- **Claim, lease, heartbeat:** the runner taking a ready todo, holding it for a time, and
  renewing that. Owner: `server/src/resolvers/runs.ts`.
- **Run token, run reach:** what a run's `/mcp` calls may touch: notes on its own todo,
  and the todos under it and those its runs made. Owner: `run-reach.ts`.
- **What a run is handed:** a system prompt of four layers (the account's agent
  instructions, the project's description, the project's prompt, the agent's prompt),
  and its todo, with its last report, why it came back and its thread. Owner: `assignmentFor`, the runner's `Assignment` (the word
  retired by R5).
- **Session:** a todo as an agent's MCP hooks see it, one per agent per todo; its runs
  are turns of it. Owner: `todo_sessions`.
- **Change feed:** what changed in a project since a cursor. Owner: `changes(since:)`,
  `server/src/changes.ts`.
- **Request:** still two things in the code: a run request (`runRequestedAt`) and the
  agent form's Requests group. Owner: R4.

## Explain test

A person keeps todos in the lanes of a project. A lane with an agent works each todo that
is ready in it: the runner claims it and the agent gets an assignment, with the standing
protocol. Its reply is one outcome, a ruling, a report, a refine or a split, and only
`finishRun` applies it to the todo, which then takes the lane's success or failure route,
or becomes an umbrella that its pieces complete. The todo's history says when it arrived in its lane,
and work since then is not repeated. People and API keys change todos directly within
their reach; a run changes the todos it made freely, and its own todo only through its
outcome, and AI sees nothing its owner has switched off or marked hands off.
