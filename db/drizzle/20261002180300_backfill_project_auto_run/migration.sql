-- Boards that had AI on were already running by themselves: keep them so.
UPDATE "projects" SET "auto_run" = true WHERE "ai_enabled";
