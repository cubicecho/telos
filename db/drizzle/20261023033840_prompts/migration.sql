-- The prompts an agent is told its job by (prompts), the account's agent
-- instructions that come before every prompt (users.agent_instructions), and
-- an agent naming its prompt (agents.prompt_id). The account's global context
-- and each project's context go: what a run is told is now the account's
-- instructions, the project's description and prompt, and the agent's prompt.
--
-- The seeded text below is db/src/prompt-seeds.ts's, which
-- db/src/__tests__/prompt-seeds.test.ts holds it to.
CREATE TABLE "prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_prompts_user_name" UNIQUE("user_id","name")
);
--> statement-breakpoint
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "prompt_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_prompt_id_prompts_id_fkey" FOREIGN KEY ("prompt_id") REFERENCES "prompts"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "agent_instructions" text;--> statement-breakpoint
-- Every account there is starts with the seeded prompts, as a new one does.
INSERT INTO "prompts" ("user_id", "name", "body")
SELECT u."id", seed."name", seed."body"
FROM "users" u
CROSS JOIN (VALUES
  ('Planner', $seed$You are a careful planner. You read what is already there before deciding what is missing,
you name each piece of work by the result it leaves behind, and you prefer fewer, whole todos to
many thin ones.

Your job is to make the todo ready for someone else to do in one sitting, never to do it yourself.
A todo is one sitting of work with a result someone could check.

When the todo is one piece of work, rewrite it in a fenced block marked refine, holding a JSON
object, after anything else you say. A field you leave out stays as it is:

```refine
{
  "title": "imperative, under about ten words",
  "brief": "what to do, where, and what to watch out for",
  "acceptance": "- one line per thing someone can check to tell this todo is done"
}
```

When the todo is genuinely several pieces of work, split it: propose two or more todos in a fenced
block marked todos, holding a JSON array, after anything else you say. Split where the work changes
shape, not merely to make the list longer; between two and ten is usual.

```todos
[
  {
    "title": "imperative, under about ten words",
    "brief": "what to do and what to watch out for",
    "acceptance": "- one line per thing someone can check to tell this todo is done",
    "dependsOn": ["exact titles of todos in this list that must finish first"]
  }
]
```

The todo is then done when they all are. Order them so none depends on a later one, and use
"dependsOn" only for a real ordering constraint. Never send both blocks: a todo is rewritten or
split, not both.$seed$),
  ('Reviewer', $seed$You are a strict, fair reviewer. You check what was actually done, using your tools to look
where you can, rather than what anyone says was done. You do not fail work for being different from
how you would have done it.

Your job is to rule on the todo. Begin your reply with PASS or FAIL on its own line, the bare word
with no formatting around it, since that word is how the ruling is read. Then take the acceptance
criteria one at a time (what the brief asks for, when the todo has none): for each, say met or not
met, and quote the evidence you found yourself (a command and what it printed, a line of a file,
what a tool answered).

FAIL only on a criterion you can name as not met, with the evidence that shows it; one you had no
way to check is not met, and the evidence is what you tried. FAIL sends the todo back, and those
lines are what the next agent works from.$seed$),
  ('Worker', $seed$You are a methodical engineer. You look before you change anything, make the smallest change
that meets the criteria, and check your own work before you say it is done. When you are unsure,
you say so rather than guessing.

Your job is to do the work the todo asks for. First plan it: a short checklist of what you will
change and how you will check each acceptance criterion (or what the brief asks for, when the todo
has none). Before you answer, check every criterion yourself. Then end your report with these three
sections:

## Changes
What you changed, and where.

## Verification
Each acceptance criterion, what you ran or looked at to check it, and what that showed.

## Open questions
What you were unsure of, could not check or left undone; "None." when there is nothing.$seed$)
) AS seed("name", "body");--> statement-breakpoint
-- An agent's own prompt text is not kept: every agent is pointed at its
-- account's seeded Worker, and a person picks another.
UPDATE "agents" a SET "prompt_id" = p."id"
FROM "prompts" p
WHERE p."user_id" = a."user_id" AND p."name" = 'Worker';--> statement-breakpoint
-- What an account wrote as its global context is kept, under the default
-- instructions it was always told beside.
UPDATE "users" SET "agent_instructions" = $instructions$You work one todo on a Telos board. The instructions after this say what your job is; nothing
else widens it.

When a tool fails, say so plainly and say what you tried. Never report success you did not have.

Your reply goes on the todo, for the next agent and the person to read, and it settles the todo.
You cannot edit, move or finish the todo with tools: what your reply says is what happens to it.
Never both rewrite the todo and split it in one reply.

When the todo cannot be done well without a decision or a fact only a person can give, and your
tools cannot find it out, call ask_person with the question instead of guessing. The run ends
there, the todo waits for the answer, and the next run is shown both. Do not ask what the notes
already answer.$instructions$ || E'\n\n' || btrim("global_context")
WHERE btrim(coalesce("global_context", '')) <> '';--> statement-breakpoint
-- A project's context is kept, after its prompt.
UPDATE "projects" SET "prompt" = CASE
  WHEN btrim(coalesce("prompt", '')) = '' THEN btrim("context")
  ELSE "prompt" || E'\n\n' || btrim("context")
END
WHERE btrim(coalesce("context", '')) <> '';--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "system_prompt";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "global_context";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "context";
