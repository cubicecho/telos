CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"model" text NOT NULL,
	"api_key" text,
	"system_prompt" text,
	"temperature" double precision,
	"max_tokens" integer,
	"context_length" integer,
	"max_tool_iterations" integer DEFAULT 20 NOT NULL,
	"tool_discovery" boolean DEFAULT false NOT NULL,
	"tool_select_model" text,
	"request_timeout_seconds" integer,
	"max_retries" integer,
	"mcp_servers" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_agents_max_tool_iterations" CHECK ("max_tool_iterations" > 0)
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"todo_id" uuid NOT NULL,
	"lane_id" uuid,
	"agent_id" uuid,
	"contract" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"verdict" text DEFAULT 'none' NOT NULL,
	"output" text,
	"error" text,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "ck_runs_status" CHECK ("status" in ('running', 'ok', 'error', 'stopped')),
	CONSTRAINT "ck_runs_verdict" CHECK ("verdict" in ('none', 'pass', 'fail')),
	CONSTRAINT "ck_runs_contract" CHECK ("contract" in ('work', 'verdict', 'expand'))
);
--> statement-breakpoint
ALTER TABLE "lanes" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "lanes" ADD COLUMN "contract" text DEFAULT 'work' NOT NULL;--> statement-breakpoint
ALTER TABLE "lanes" ADD COLUMN "prompt" text;--> statement-breakpoint
ALTER TABLE "lanes" ADD COLUMN "on_success_lane_id" uuid;--> statement-breakpoint
ALTER TABLE "lanes" ADD COLUMN "on_failure_lane_id" uuid;--> statement-breakpoint
ALTER TABLE "lanes" ADD COLUMN "wip_limit" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "lanes" ADD COLUMN "max_attempts" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_agents_user_id" ON "agents" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_lanes_agent_id" ON "lanes" ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_lanes_on_success_lane_id" ON "lanes" ("on_success_lane_id");--> statement-breakpoint
CREATE INDEX "idx_lanes_on_failure_lane_id" ON "lanes" ("on_failure_lane_id");--> statement-breakpoint
CREATE INDEX "idx_runs_user_id" ON "runs" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_runs_project_id" ON "runs" ("project_id");--> statement-breakpoint
CREATE INDEX "idx_runs_todo_id" ON "runs" ("todo_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_runs_lane_id" ON "runs" ("lane_id");--> statement-breakpoint
CREATE INDEX "idx_runs_agent_id" ON "runs" ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_runs_todo_running" ON "runs" ("todo_id") WHERE status = 'running';--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "lanes" ADD CONSTRAINT "lanes_agent_id_agents_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "lanes" ADD CONSTRAINT "lanes_on_success_lane_id_lanes_id_fkey" FOREIGN KEY ("on_success_lane_id") REFERENCES "lanes"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "lanes" ADD CONSTRAINT "lanes_on_failure_lane_id_lanes_id_fkey" FOREIGN KEY ("on_failure_lane_id") REFERENCES "lanes"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_todo_id_todos_id_fkey" FOREIGN KEY ("todo_id") REFERENCES "todos"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_lane_id_lanes_id_fkey" FOREIGN KEY ("lane_id") REFERENCES "lanes"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_id_agents_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "lanes" ADD CONSTRAINT "ck_lanes_contract" CHECK ("contract" in ('work', 'verdict', 'expand'));--> statement-breakpoint
ALTER TABLE "lanes" ADD CONSTRAINT "ck_lanes_wip_limit" CHECK ("wip_limit" > 0);--> statement-breakpoint
ALTER TABLE "lanes" ADD CONSTRAINT "ck_lanes_max_attempts" CHECK ("max_attempts" >= 0);