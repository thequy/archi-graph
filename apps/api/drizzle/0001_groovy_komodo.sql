-- Projects-extension + backfill migration.
--
-- HAND-EDITED after drizzle-kit generate. The generator emitted
--   ALTER TABLE "branches" ADD COLUMN "project_id" uuid DEFAULT '…' NOT NULL;
--   ALTER TABLE "branches" ADD CONSTRAINT …_fk FOREIGN KEY …;
-- in that order, which is UNSAFE for pre-existing data: ADD COLUMN would stamp
-- every existing branch with the demo-project id, but the referenced project
-- row does not exist yet, so the subsequent FK (validated immediately) fails.
--
-- The safe order (no branch ever orphaned, no NOT NULL/FK applied before the
-- data satisfies it) is:
--   1. create `projects`
--   2. INSERT the demo "CorpDigi" project (stable id)
--   3. add project_id columns NULLABLE everywhere
--   4. backfill: UPDATE every existing branch / doc_chunk / embedding_job to
--      the demo project
--   5. branches.project_id -> SET DEFAULT demo + SET NOT NULL
--   6. add the FK (now every row references a real project)
-- Every step is idempotent so re-running the migrator is safe.

-- 1. projects table
CREATE TABLE IF NOT EXISTS "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- 2. default "CorpDigi" project at a stable id (adopts all v1 data).
INSERT INTO "projects" ("id", "name", "description")
VALUES ('11111111-1111-1111-1111-111111111111', 'CorpDigi', 'Default project (migrated from Archi-Graph v1).')
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
-- 3. add project_id columns NULLABLE first so ADD COLUMN cannot fail on rows.
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "project_id" uuid;--> statement-breakpoint
ALTER TABLE "doc_chunks" ADD COLUMN IF NOT EXISTS "project_id" uuid;--> statement-breakpoint
ALTER TABLE "embedding_jobs" ADD COLUMN IF NOT EXISTS "project_id" uuid;--> statement-breakpoint
-- 4. backfill all pre-existing rows to the demo project. No branch orphaned.
UPDATE "branches" SET "project_id" = '11111111-1111-1111-1111-111111111111' WHERE "project_id" IS NULL;--> statement-breakpoint
UPDATE "doc_chunks" SET "project_id" = '11111111-1111-1111-1111-111111111111' WHERE "project_id" IS NULL;--> statement-breakpoint
UPDATE "embedding_jobs" SET "project_id" = '11111111-1111-1111-1111-111111111111' WHERE "project_id" IS NULL;--> statement-breakpoint
-- 5. only NOW is it safe to default + enforce NOT NULL on branches.
ALTER TABLE "branches" ALTER COLUMN "project_id" SET DEFAULT '11111111-1111-1111-1111-111111111111';--> statement-breakpoint
ALTER TABLE "branches" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
-- 6. add the FK last, when every branch references a real project.
DO $$ BEGIN
 ALTER TABLE "branches" ADD CONSTRAINT "branches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
