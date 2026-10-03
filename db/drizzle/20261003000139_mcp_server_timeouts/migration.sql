ALTER TABLE "mcp_servers" ADD COLUMN "cwd" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "connect_timeout_ms" integer;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "call_timeout_ms" integer;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "idle_timeout_ms" integer;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "ck_mcp_servers_timeouts" CHECK (("connect_timeout_ms" IS NULL OR "connect_timeout_ms" > 0) AND ("call_timeout_ms" IS NULL OR "call_timeout_ms" > 0) AND ("idle_timeout_ms" IS NULL OR "idle_timeout_ms" >= 0));