-- Telos no longer runs stdio MCP servers: every server is a URL. A row without
-- one was a command the runner spawned, and nothing can reach it any more, so it
-- goes, with its secrets (they are its own columns). An agent's list loses its
-- slug, so it does not name a server that is gone; a list left empty means
-- "none", which is what that agent could reach once the server could not run.
-- A row with both a URL and a command keeps the URL and loses the command.
UPDATE "agents" AS a
SET "mcp_server_slugs" = (
  SELECT COALESCE(jsonb_agg(slug ORDER BY ord), '[]'::jsonb)
  FROM jsonb_array_elements(a."mcp_server_slugs") WITH ORDINALITY AS listed(slug, ord)
  WHERE NOT EXISTS (
    SELECT 1 FROM "mcp_servers" s
    WHERE s."user_id" = a."user_id" AND s."url" IS NULL AND to_jsonb(s."slug") = listed.slug
  )
)
WHERE jsonb_typeof(a."mcp_server_slugs") = 'array'
  AND EXISTS (
    SELECT 1 FROM "mcp_servers" s
    WHERE s."user_id" = a."user_id" AND s."url" IS NULL AND a."mcp_server_slugs" @> jsonb_build_array(s."slug")
  );--> statement-breakpoint
DELETE FROM "mcp_servers" WHERE "url" IS NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP CONSTRAINT "ck_mcp_servers_target";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP COLUMN "command";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP COLUMN "args";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP COLUMN "cwd";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP COLUMN "env";--> statement-breakpoint
ALTER TABLE "mcp_servers" ALTER COLUMN "url" SET NOT NULL;
