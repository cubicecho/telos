ALTER TABLE "agent_defaults" ADD COLUMN "reasoning_replay" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "reasoning_replay" text;--> statement-breakpoint
ALTER TABLE "agent_defaults" ADD CONSTRAINT "ck_agent_defaults_reasoning_replay" CHECK ("reasoning_replay" in ('all', 'tool-loop', 'none'));--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "ck_agents_reasoning_replay" CHECK ("reasoning_replay" in ('all', 'tool-loop', 'none'));