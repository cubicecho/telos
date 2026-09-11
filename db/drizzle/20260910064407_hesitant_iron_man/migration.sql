CREATE TABLE "lanes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"is_done" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "todos" ADD COLUMN "lane_id" uuid;--> statement-breakpoint
CREATE INDEX "idx_lanes_user_id" ON "lanes" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_lanes_project_id" ON "lanes" ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_lanes_project_done" ON "lanes" ("project_id") WHERE is_done;--> statement-breakpoint
CREATE INDEX "idx_todos_lane_id" ON "todos" ("lane_id");--> statement-breakpoint
ALTER TABLE "lanes" ADD CONSTRAINT "lanes_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "lanes" ADD CONSTRAINT "lanes_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_lane_id_lanes_id_fkey" FOREIGN KEY ("lane_id") REFERENCES "lanes"("id") ON DELETE SET NULL;--> statement-breakpoint
-- Backfill: every project that predates lanes gets the same default board a new
-- project is seeded with, so the Board tab is never empty on an existing install.
INSERT INTO "lanes" ("user_id", "project_id", "name", "position", "is_done")
SELECT p."user_id", p."id", seed."name", seed."position", seed."is_done"
FROM "projects" p
CROSS JOIN (VALUES ('To do', 0, false), ('In progress', 1, false), ('Done', 2, true))
  AS seed("name", "position", "is_done");--> statement-breakpoint
-- Existing todos land in the column their completion already implies.
UPDATE "todos" t
SET "lane_id" = l."id"
FROM "lanes" l
WHERE l."project_id" = t."project_id"
  AND l."position" = CASE WHEN t."completed_at" IS NOT NULL THEN 2 ELSE 0 END;
