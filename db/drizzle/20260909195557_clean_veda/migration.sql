CREATE TABLE "labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_labels_user_name" UNIQUE("user_id","name")
);
--> statement-breakpoint
CREATE TABLE "project_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	CONSTRAINT "uq_project_labels_pair" UNIQUE("project_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "todo_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"todo_id" uuid NOT NULL,
	"depends_on_todo_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_todo_dependencies_pair" UNIQUE("todo_id","depends_on_todo_id")
);
--> statement-breakpoint
CREATE TABLE "todo_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"todo_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	CONSTRAINT "uq_todo_labels_pair" UNIQUE("todo_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "todos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"completed_at" timestamp with time zone,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"email" text NOT NULL UNIQUE,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_labels_user_id" ON "labels" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_project_labels_user_id" ON "project_labels" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_project_labels_project_id" ON "project_labels" ("project_id");--> statement-breakpoint
CREATE INDEX "idx_project_labels_label_id" ON "project_labels" ("label_id");--> statement-breakpoint
CREATE INDEX "idx_projects_user_id" ON "projects" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_todo_dependencies_user_id" ON "todo_dependencies" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_todo_dependencies_todo_id" ON "todo_dependencies" ("todo_id");--> statement-breakpoint
CREATE INDEX "idx_todo_dependencies_depends_on" ON "todo_dependencies" ("depends_on_todo_id");--> statement-breakpoint
CREATE INDEX "idx_todo_labels_user_id" ON "todo_labels" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_todo_labels_todo_id" ON "todo_labels" ("todo_id");--> statement-breakpoint
CREATE INDEX "idx_todo_labels_label_id" ON "todo_labels" ("label_id");--> statement-breakpoint
CREATE INDEX "idx_todos_user_id" ON "todos" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_todos_project_id" ON "todos" ("project_id");--> statement-breakpoint
CREATE INDEX "idx_todos_completed_at" ON "todos" ("completed_at");--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_labels" ADD CONSTRAINT "project_labels_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_labels" ADD CONSTRAINT "project_labels_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_labels" ADD CONSTRAINT "project_labels_label_id_labels_id_fkey" FOREIGN KEY ("label_id") REFERENCES "labels"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "todo_dependencies" ADD CONSTRAINT "todo_dependencies_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "todo_dependencies" ADD CONSTRAINT "todo_dependencies_todo_id_todos_id_fkey" FOREIGN KEY ("todo_id") REFERENCES "todos"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "todo_dependencies" ADD CONSTRAINT "todo_dependencies_depends_on_todo_id_todos_id_fkey" FOREIGN KEY ("depends_on_todo_id") REFERENCES "todos"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "todo_labels" ADD CONSTRAINT "todo_labels_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "todo_labels" ADD CONSTRAINT "todo_labels_todo_id_todos_id_fkey" FOREIGN KEY ("todo_id") REFERENCES "todos"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "todo_labels" ADD CONSTRAINT "todo_labels_label_id_labels_id_fkey" FOREIGN KEY ("label_id") REFERENCES "labels"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;