CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"command" text,
	"args" jsonb DEFAULT '[]' NOT NULL,
	"headers" jsonb DEFAULT '{}' NOT NULL,
	"env" jsonb DEFAULT '{}' NOT NULL,
	"hooks" jsonb DEFAULT '[]' NOT NULL,
	"hidden_tools" jsonb DEFAULT '[]' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"checked_at" timestamp with time zone,
	"check_ok" boolean,
	"check_error" text,
	"tools" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_mcp_servers_slug" CHECK ("slug" ~ '^[A-Za-z0-9_-]+$' AND "slug" <> 'telos'),
	CONSTRAINT "ck_mcp_servers_target" CHECK ("url" IS NOT NULL OR "command" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "mcp_server_slugs" jsonb;--> statement-breakpoint
CREATE INDEX "idx_mcp_servers_user_id" ON "mcp_servers" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mcp_servers_user_slug" ON "mcp_servers" ("user_id","slug");--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
-- Lifts each agent's own servers into the account's registry. Definitions that
-- are the same but for their name become one server; the agent keeps a list of
-- the slugs it had, which is an empty list (no servers) for one that had none.
-- A slug is the old id where that was something a person wrote, since tools
-- were named under it, and comes from the name where the id was a uuid.
DO $$
DECLARE
  agent record;
  entry jsonb;
  picked jsonb;
  found text;
  base text;
  candidate text;
  suffix integer;
  entry_url text;
  entry_command text;
  entry_args jsonb;
  entry_headers jsonb;
  entry_env jsonb;
  entry_hooks jsonb;
  entry_hidden jsonb;
BEGIN
  FOR agent IN SELECT id, user_id, mcp_servers FROM agents ORDER BY created_at, id LOOP
    picked := '[]'::jsonb;
    IF jsonb_typeof(agent.mcp_servers) = 'array' THEN
      FOR entry IN SELECT value FROM jsonb_array_elements(agent.mcp_servers) LOOP
        CONTINUE WHEN jsonb_typeof(entry) <> 'object';
        entry_url := nullif(btrim(coalesce(entry->>'url', '')), '');
        entry_command := nullif(btrim(coalesce(entry->>'command', '')), '');
        CONTINUE WHEN entry_url IS NULL AND entry_command IS NULL;
        entry_args := CASE WHEN jsonb_typeof(entry->'args') = 'array' THEN entry->'args' ELSE '[]'::jsonb END;
        entry_headers := CASE WHEN jsonb_typeof(entry->'headers') = 'object' THEN entry->'headers' ELSE '{}'::jsonb END;
        entry_env := CASE WHEN jsonb_typeof(entry->'env') = 'object' THEN entry->'env' ELSE '{}'::jsonb END;
        entry_hooks := CASE WHEN jsonb_typeof(entry->'hooks') = 'array' THEN entry->'hooks' ELSE '[]'::jsonb END;
        entry_hidden := CASE WHEN jsonb_typeof(entry->'hiddenTools') = 'array' THEN entry->'hiddenTools' ELSE '[]'::jsonb END;

        SELECT slug INTO found FROM mcp_servers
        WHERE user_id = agent.user_id
          AND url IS NOT DISTINCT FROM entry_url AND command IS NOT DISTINCT FROM entry_command
          AND args = entry_args AND headers = entry_headers AND env = entry_env
          AND hooks = entry_hooks AND hidden_tools = entry_hidden
        LIMIT 1;

        IF found IS NULL THEN
          IF coalesce(entry->>'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            base := lower(coalesce(entry->>'name', ''));
          ELSE
            base := coalesce(entry->>'id', '');
          END IF;
          base := btrim(regexp_replace(base, '[^A-Za-z0-9_-]+', '_', 'g'), '_');
          IF base = '' OR base = 'telos' THEN
            base := 'server';
          END IF;
          candidate := base;
          suffix := 1;
          WHILE EXISTS (SELECT 1 FROM mcp_servers WHERE user_id = agent.user_id AND slug = candidate) LOOP
            suffix := suffix + 1;
            candidate := base || '_' || suffix;
          END LOOP;
          INSERT INTO mcp_servers (user_id, slug, name, url, command, args, headers, env, hooks, hidden_tools)
          VALUES (
            agent.user_id, candidate, coalesce(nullif(btrim(coalesce(entry->>'name', '')), ''), candidate),
            entry_url, entry_command, entry_args, entry_headers, entry_env, entry_hooks, entry_hidden
          );
          found := candidate;
        END IF;

        IF NOT picked @> jsonb_build_array(found) THEN
          picked := picked || jsonb_build_array(found);
        END IF;
      END LOOP;
    END IF;
    UPDATE agents SET mcp_server_slugs = picked WHERE id = agent.id;
  END LOOP;
END;
$$;
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "mcp_servers";
--> statement-breakpoint
-- A renamed server keeps the agents that named it.
CREATE FUNCTION rename_mcp_server() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE agents
  SET mcp_server_slugs = (
    SELECT coalesce(jsonb_agg(CASE WHEN slug.value = to_jsonb(OLD.slug) THEN to_jsonb(NEW.slug) ELSE slug.value END), '[]'::jsonb)
    FROM jsonb_array_elements(mcp_server_slugs) AS slug
  )
  WHERE user_id = NEW.user_id AND mcp_server_slugs @> jsonb_build_array(OLD.slug);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mcp_servers_rename AFTER UPDATE OF slug ON mcp_servers
FOR EACH ROW WHEN (OLD.slug IS DISTINCT FROM NEW.slug) EXECUTE FUNCTION rename_mcp_server();
