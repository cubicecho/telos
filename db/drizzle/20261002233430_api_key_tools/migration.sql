CREATE TABLE "api_key_tools" (
	"key_id" uuid PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"off" jsonb DEFAULT '[]' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_api_key_tools_user_id" ON "api_key_tools" ("user_id");--> statement-breakpoint
ALTER TABLE "api_key_tools" ADD CONSTRAINT "api_key_tools_key_id_apikeys_id_fkey" FOREIGN KEY ("key_id") REFERENCES "apikeys"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "api_key_tools" ADD CONSTRAINT "api_key_tools_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;