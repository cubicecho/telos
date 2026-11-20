ALTER TABLE "agent_defaults" ADD COLUMN "remote_agent" boolean;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "remote_agent" boolean;