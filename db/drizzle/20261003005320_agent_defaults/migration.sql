CREATE TABLE "agent_defaults" (
	"user_id" uuid PRIMARY KEY,
	"base_url" text,
	"model" text,
	"api_key" text,
	"temperature" double precision,
	"max_tokens" integer,
	"context_length" integer,
	"max_tool_iterations" integer,
	"tool_discovery" boolean,
	"tool_select_model" text,
	"request_timeout_seconds" integer,
	"max_retries" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_agent_defaults_max_tool_iterations" CHECK ("max_tool_iterations" > 0)
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "base_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "model" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "max_tool_iterations" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "max_tool_iterations" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "tool_discovery" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "tool_discovery" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_defaults" ADD CONSTRAINT "agent_defaults_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
--> statement-breakpoint
-- Until now the runner filled an agent's blanks with constants of its own. An
-- account that already has agents gets them as its defaults, so its runs go on
-- as they did and the numbers are now somewhere a person can see and change.
INSERT INTO agent_defaults (user_id, temperature, max_tokens, request_timeout_seconds, max_retries)
SELECT DISTINCT user_id, 0.2, 4096, 300, 2 FROM agents
ON CONFLICT (user_id) DO NOTHING;
--> statement-breakpoint
-- These two were required, so every agent stated the column default whether
-- or not anyone chose it. That default is what agent-core falls back to anyway
-- (20 iterations, eager tools), so clearing it changes no run and lets the
-- agent inherit the account's value from now on.
UPDATE agents SET max_tool_iterations = NULL WHERE max_tool_iterations = 20;
--> statement-breakpoint
UPDATE agents SET tool_discovery = NULL WHERE tool_discovery = false;