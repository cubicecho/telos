ALTER TABLE "projects" ADD COLUMN "run_mode" text DEFAULT 'lane' NOT NULL;--> statement-breakpoint
ALTER TABLE "todos" ADD COLUMN "followed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "ck_projects_run_mode" CHECK ("run_mode" in ('auto', 'lane', 'follow'));