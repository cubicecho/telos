CREATE TABLE "instance_settings" (
	"id" text PRIMARY KEY DEFAULT 'instance',
	"ai_enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_settings_singleton" CHECK ("id" = 'instance')
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- The first account runs the instance; a new one is only made an admin in the database.
UPDATE "users" SET "is_admin" = true WHERE "id" = (SELECT "id" FROM "users" ORDER BY "created_at", "id" LIMIT 1);
