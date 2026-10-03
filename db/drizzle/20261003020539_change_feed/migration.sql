CREATE TABLE "change_log" (
	"entity" text,
	"entity_id" uuid,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"todo_id" uuid,
	"depends_on_todo_id" uuid,
	"deleted_at" timestamp with time zone,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"xid" bigint NOT NULL,
	"seq" bigint NOT NULL,
	"ai_seen" boolean DEFAULT false NOT NULL,
	CONSTRAINT "change_log_pkey" PRIMARY KEY("entity","entity_id"),
	CONSTRAINT "ck_change_log_entity" CHECK ("entity" IN ('project', 'todo', 'dependency'))
);
--> statement-breakpoint
CREATE INDEX "idx_change_log_user_position" ON "change_log" ("user_id","xid","seq");--> statement-breakpoint
CREATE INDEX "idx_change_log_deleted_at" ON "change_log" ("deleted_at") WHERE deleted_at IS NOT NULL;--> statement-breakpoint
ALTER TABLE "change_log" ADD CONSTRAINT "change_log_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
-- The change feed's log (server/src/changes.ts): one row per project, todo and
-- dependency edge, replaced on each change and made a tombstone on delete.
-- Triggers rather than writes in the resolvers, because those rows change
-- through generated CRUD, hand-written mutations, the runner, other triggers
-- and cascades (a project's delete takes its todos and their edges, a todo's
-- its edges), and a trigger is the one place none of them can forget.
--
-- The feed orders by (xid, seq): the writing transaction, then the order within
-- it. The sequence's values carry no meaning beyond that order.
CREATE SEQUENCE change_log_seq;
--> statement-breakpoint
CREATE FUNCTION stamp_change(
  p_entity text, p_id uuid, p_user uuid, p_project uuid, p_todo uuid, p_depends_on uuid,
  p_deleted boolean, p_ai_seen boolean
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- A delete that is part of deleting the account leaves nobody to tell, and
  -- the row could not reference the account anyway.
  IF p_deleted AND NOT EXISTS (SELECT 1 FROM users WHERE id = p_user) THEN
    RETURN;
  END IF;
  INSERT INTO change_log AS c (
    entity, entity_id, user_id, project_id, todo_id, depends_on_todo_id, deleted_at, changed_at, xid, seq, ai_seen
  ) VALUES (
    p_entity, p_id, p_user, p_project, p_todo, p_depends_on, CASE WHEN p_deleted THEN now() END, now(),
    pg_current_xact_id()::text::bigint, nextval('change_log_seq'), p_ai_seen
  )
  ON CONFLICT (entity, entity_id) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    -- A dependency's tombstone cannot look its project up: its todo may be
    -- going in the same statement. It keeps the one it was last written with.
    project_id = coalesce(EXCLUDED.project_id, c.project_id),
    todo_id = EXCLUDED.todo_id,
    depends_on_todo_id = EXCLUDED.depends_on_todo_id,
    deleted_at = EXCLUDED.deleted_at,
    changed_at = EXCLUDED.changed_at,
    xid = EXCLUDED.xid,
    seq = EXCLUDED.seq,
    -- Once AI could see it, AI may be told it went.
    ai_seen = c.ai_seen OR EXCLUDED.ai_seen;
END;
$$;
--> statement-breakpoint
-- What AI may see, as tenancy.ts says it (AI_SCOPES): a project with AI on; a
-- todo not ignored, in such a project; an edge whose two ends AI sees and
-- neither is archived. changes.test.ts holds the two to each other.
CREATE FUNCTION project_open_to_ai(p_project uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT ai_enabled FROM projects WHERE id = p_project), false);
$$;
--> statement-breakpoint
CREATE FUNCTION edge_end_open_to_ai(p_todo uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM todos t JOIN projects p ON p.id = t.project_id
    WHERE t.id = p_todo AND NOT t.ai_ignored AND t.archived_at IS NULL AND p.ai_enabled
  );
$$;
--> statement-breakpoint
CREATE FUNCTION stamp_project(p projects) RETURNS void LANGUAGE sql AS $$
  SELECT stamp_change('project', p.id, p.user_id, p.id, NULL, NULL, false, p.ai_enabled);
$$;
--> statement-breakpoint
CREATE FUNCTION stamp_todo(t todos) RETURNS void LANGUAGE sql AS $$
  SELECT stamp_change('todo', t.id, t.user_id, t.project_id, NULL, NULL, false,
    NOT t.ai_ignored AND project_open_to_ai(t.project_id));
$$;
--> statement-breakpoint
CREATE FUNCTION stamp_dependency(d todo_dependencies) RETURNS void LANGUAGE sql AS $$
  SELECT stamp_change('dependency', d.id, d.user_id, (SELECT project_id FROM todos WHERE id = d.todo_id),
    d.todo_id, d.depends_on_todo_id, false,
    edge_end_open_to_ai(d.todo_id) AND edge_end_open_to_ai(d.depends_on_todo_id));
$$;
--> statement-breakpoint
-- A project's AI switch decides what AI sees of everything in it, so turning
-- it re-stamps its todos and their edges: AI is told they went, or that they
-- are there again.
CREATE FUNCTION change_log_projects() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM stamp_change('project', OLD.id, OLD.user_id, OLD.id, NULL, NULL, true, false);
    RETURN NULL;
  END IF;
  PERFORM stamp_project(NEW);
  IF TG_OP = 'UPDATE' AND OLD.ai_enabled IS DISTINCT FROM NEW.ai_enabled THEN
    PERFORM stamp_todo(t) FROM todos t WHERE t.project_id = NEW.id;
    PERFORM stamp_dependency(d) FROM todo_dependencies d
    WHERE d.todo_id IN (SELECT id FROM todos WHERE project_id = NEW.id)
       OR d.depends_on_todo_id IN (SELECT id FROM todos WHERE project_id = NEW.id);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- A todo ignored, archived or moved to another project changes what AI sees
-- of its edges, so they are re-stamped with it.
CREATE FUNCTION change_log_todos() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM stamp_change('todo', OLD.id, OLD.user_id, OLD.project_id, NULL, NULL, true, false);
    RETURN NULL;
  END IF;
  PERFORM stamp_todo(NEW);
  IF TG_OP = 'UPDATE' AND (OLD.ai_ignored, OLD.archived_at, OLD.project_id)
      IS DISTINCT FROM (NEW.ai_ignored, NEW.archived_at, NEW.project_id) THEN
    PERFORM stamp_dependency(d) FROM todo_dependencies d WHERE d.todo_id = NEW.id OR d.depends_on_todo_id = NEW.id;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION change_log_dependencies() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM stamp_change('dependency', OLD.id, OLD.user_id, NULL, OLD.todo_id, OLD.depends_on_todo_id, true, false);
    RETURN NULL;
  END IF;
  PERFORM stamp_dependency(NEW);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- An update that changes nothing is not a change: reordering rewrites rows it
-- leaves where they were, and a consumer would fetch them for nothing.
CREATE TRIGGER projects_change_log AFTER INSERT OR DELETE ON projects
  FOR EACH ROW EXECUTE FUNCTION change_log_projects();
--> statement-breakpoint
CREATE TRIGGER projects_change_log_update AFTER UPDATE ON projects
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION change_log_projects();
--> statement-breakpoint
CREATE TRIGGER todos_change_log AFTER INSERT OR DELETE ON todos
  FOR EACH ROW EXECUTE FUNCTION change_log_todos();
--> statement-breakpoint
CREATE TRIGGER todos_change_log_update AFTER UPDATE ON todos
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION change_log_todos();
--> statement-breakpoint
CREATE TRIGGER todo_dependencies_change_log AFTER INSERT OR DELETE ON todo_dependencies
  FOR EACH ROW EXECUTE FUNCTION change_log_dependencies();
--> statement-breakpoint
CREATE TRIGGER todo_dependencies_change_log_update AFTER UPDATE ON todo_dependencies
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION change_log_dependencies();
--> statement-breakpoint
-- What is there already, so a consumer starting from nothing gets all of it.
SELECT stamp_project(p) FROM projects p;
--> statement-breakpoint
SELECT stamp_todo(t) FROM todos t;
--> statement-breakpoint
SELECT stamp_dependency(d) FROM todo_dependencies d;