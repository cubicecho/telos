CREATE TABLE "board_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"lanes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_board_templates_user_name" UNIQUE("user_id","name")
);
--> statement-breakpoint
CREATE INDEX "idx_board_templates_user_id" ON "board_templates" ("user_id");--> statement-breakpoint
ALTER TABLE "board_templates" ADD CONSTRAINT "board_templates_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;