ALTER TABLE "oidc_settings" ADD COLUMN "device_client_id" text;--> statement-breakpoint
ALTER TABLE "oidc_settings" ADD COLUMN "device_registration_access_token" text;--> statement-breakpoint
ALTER TABLE "oidc_settings" ADD COLUMN "device_registration_client_uri" text;