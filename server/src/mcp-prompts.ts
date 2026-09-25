import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v3';

// The prompts offered beside the MCP door's tools (mcp.ts).
//
// A tool's description has room to say what it does, not how the board works:
// that a lane with an agent is a station, that a request is a todo, that an MCP
// client hands work over and never works the board itself. A prompt does have
// that room. It is fetched deliberately, once, so it is the one place a client
// can be given the model rather than the schema.
//
// `telos_guide` is that orientation, and takes no arguments. The other three are
// jobs of work, written as instructions to the agent that fetched them, naming
// the tools in the order they are used, because the order is the hard part to
// guess from a tool listing.
//
// Arguments are strings, as MCP prompt arguments always are, and are pasted
// into the text. Nothing here runs anything, so there is nothing to escape.

const project = z.string().describe('The project, by name or id. Resolve it with the `projects` tool.');

const GUIDE = `You are handing work to a Telos board through its MCP tools. Read this before
the first call. The tools say what each one does; this says how the board works.

## What is here

- **Project**: a board, and a body of work. Its \`context\` is the standing description
  every agent working on it is shown. You only see projects whose owner has switched AI
  on for them.
- **Lane**: a column, in board order. A lane with an agent is a *station*: the agent
  works each todo that arrives there, and the lane says where the todo goes when that
  run succeeds or fails. A lane without an agent is a resting place, for a person to act
  on. One lane per project may be the done lane: a todo that reaches it is complete.
- **Todo**: the unit of work. A *request* is simply a todo you submitted: its \`brief\`
  and \`acceptance\` are all the first agent gets, beside the project's context.
- **Thread**: notes on a todo. \`report\` is what an agent made of it, \`verdict\` is a
  reviewer's PASS or FAIL and why, \`note\` is anything a person or you added. Every one
  is handed to the next agent that works the todo.
- **History**: each move, edit, completion and reopening, with who did it and why.

## What a station does

A station's contract is one of three things. \`work\` does the todo and reports.
\`verdict\` judges it against its acceptance and rules PASS or FAIL. \`expand\` splits it
into child todos, which is the one place work is broken up. After a run the todo
moves along the lane's success or failure arrow, if it has one. A station gives up on a
todo after a few failed attempts, until a person touches it.

A todo is *blocked* while another it depends on is unfinished: stations skip it until
then. That is queued, not stuck.

## What you can do, and what you cannot

You can read (\`projects\`, \`todos\`, \`request\`), hand work over (\`submit_request\`),
say more about it (\`add_todo_note\`), and withdraw it (\`cancel_request\`). You cannot
move, edit, complete, retry or delete a todo, create a project, or change a lane: the
board belongs to a person, and its stations do the work. When something needs one of
those, say what and why, and leave it to the person.

## Start here

Call \`projects\` to see the boards open to you, with their lanes in order, before
putting anything onto one.`;

/**
 * One prompt. `args` is a zod raw shape of strings, since MCP prompt arguments
 * are strings; `render` is handed whatever of them arrived.
 */
interface Prompt {
  name: string;
  title: string;
  description: string;
  args?: Record<string, z.ZodString | z.ZodOptional<z.ZodString>>;
  render: (args: Record<string, string | undefined>) => string;
}

export const PROMPTS: readonly Prompt[] = [
  {
    name: 'telos_guide',
    title: 'How a Telos board works',
    description:
      'Orientation for an agent about to hand work to Telos: what a project, lane, station, ' +
      'todo, thread and history are, what the stations do, and what an MCP client may and may ' +
      'not do. Fetch this before the first tool call.',
    render: () => GUIDE,
  },
  {
    name: 'start_project',
    title: 'Get new work started on a fitting board',
    description:
      'Finds the board a new body of work belongs on, or, since an MCP client cannot create ' +
      'one, says exactly what its owner should set up, then puts the first request onto it.',
    args: {
      goal: z.string().describe('What the work is for, in as much detail as you have.'),
      name: z.string().optional().describe('What the board should be called, if a new one is needed.'),
    },
    render: (args) => `Get this work started on a Telos board.

**The work:** ${args.goal}
**Board name, if one is needed:** ${args.name || 'suggest one: short, and about the work'}

1. \`projects\`. Look for a board this work belongs on, by name, description and context.
   Only boards whose owner has switched AI on are listed.
2. If none fits, stop and tell the person what to set up, since you cannot create a
   project: its name; the context every agent on it should be shown (what the project is,
   where the work lives, the constraints that apply to everything in it); a board template
   to start it from, if they keep one that fits; and that AI must be switched on for it.
   Then wait for them.
3. With a board, read its lanes in order. The request lands in the first open lane, so
   check what that lane is: if it has no agent, nothing will happen until a person moves
   the todo on.
4. \`submit_request\`. Put the work in whole, in \`brief\`: what is wanted, where it lives,
   what must not change. Put how anyone could tell it was done in \`acceptance\`, as checks
   a reviewer could make. A station that expands will break it up; do not pre-divide it.
5. \`request\` with the id you got back, to confirm where it landed.

Finish by reporting the project, the request's id and the lane it is in.`,
  },
  {
    name: 'submit_work',
    title: 'Hand a request to an existing board',
    description:
      "Turns a request in somebody's own words into a todo on a board that exists: resolving " +
      'the project, writing a brief and acceptance the first agent can use, and checking where ' +
      'it landed.',
    args: {
      project,
      request: z.string().describe('What is being asked for, in the words it was asked in.'),
    },
    render: (args) => `Hand this request to an existing Telos board.

**Board:** ${args.project}
**The request:** ${args.request}

1. Resolve the board with \`projects\`, matching on name or id. If nothing matches, say so
   and ask: never guess at a board.
2. Check it is not already there: \`todos\` for the project, looking for the same work. If
   it is, add what is new to it with \`add_todo_note\` instead of submitting it twice.
3. Write it properly, because the brief, the acceptance and the project's context are all
   the first agent gets. \`title\`: one line. \`brief\`: what is wanted and why, where it
   lives, what must not change. \`acceptance\`: the checks that say it is done, one per
   line, not buried in the brief. \`parentId\` if it is part of a todo already there.
4. \`submit_request\`, then \`request\` with the id, to confirm the lane it landed in.

Finish by reporting its id and lane. Check on it later with \`request\`: its thread will
carry the stations' reports and verdicts.`,
  },
  {
    name: 'triage_board',
    title: 'Find out what is stuck on a board',
    description:
      "Reads a board's todos, threads and histories, explains why each stuck todo is where it " +
      'is, and proposes one thing per todo: a note for the next agent, a withdrawal, or what its ' +
      'owner should do.',
    args: { project },
    render: (args) => `Work out what is stuck on this Telos board, and what should be done about it.

**Board:** ${args.project}

1. Resolve it with \`projects\`; note its lanes, which are stations and which is done.
2. \`todos\` for it. Say what the board looks like: how many todos in each lane, which are
   blocked, which are complete.
3. For each open todo that is not blocked, call \`request\` and read its thread and history,
   newest first. It is stuck if a station's last verdict was FAIL, if its reports say it
   could not be done, if it has failed at a station more than once, or if it sits in a lane
   with no agent. Say why, from what the thread and history say, rather than that it is.
4. Blocked todos are queued, not stuck, unless what blocks them will never be done. Say so
   when that is the case.
5. Propose one thing per stuck todo:
   - \`add_todo_note\`: the todo is right and the agent went wrong, and you can tell the next
     one why. It still needs its owner to retry it from the board.
   - \`cancel_request\`: nobody wants it any more.
   - For its owner: retry it, move it to another lane, edit what it asks for, or put an
     agent on a lane that needs one. You cannot do these; say which and why.

Say what you would do before doing any of it, unless you were told to go ahead.`,
  },
];

/**
 * Registers the prompts on a freshly minted server, before it is connected:
 * the SDK declares the prompts capability on the first registration, and
 * cannot once a transport is attached (graphql-mcp's `decorateServer`).
 *
 * @param server The server.
 */
export function registerPrompts(server: McpServer): void {
  for (const prompt of PROMPTS) {
    const config = { title: prompt.title, description: prompt.description };
    const render = (args: Record<string, string | undefined>) => ({
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: prompt.render(args) } }],
    });
    // No arguments is no schema, rather than an empty one: there is nothing to send.
    if (!prompt.args) {
      server.registerPrompt(prompt.name, config, () => render({}));
      continue;
    }
    // Loosened: inferring the callback's arguments from the shape is "excessively
    // deep" for tsc. The shape is strings throughout, which is what `render` takes.
    const register = server.registerPrompt.bind(server) as (
      name: string,
      config: { title: string; description: string; argsSchema: NonNullable<Prompt['args']> },
      callback: typeof render,
    ) => void;
    register(prompt.name, { ...config, argsSchema: prompt.args }, render);
  }
}
