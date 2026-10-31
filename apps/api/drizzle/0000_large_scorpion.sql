CREATE TABLE IF NOT EXISTS "branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"head_commit_id" uuid,
	"parent_commit_id" uuid,
	"author" text DEFAULT 'local' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"parent_commit_id" uuid,
	"message" text NOT NULL,
	"author" text DEFAULT 'local' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "doc_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" text NOT NULL,
	"commit_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(768),
	CONSTRAINT "doc_chunks_entity_commit_chunk_uq" UNIQUE("entity_id","commit_id","chunk_index")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "embedding_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" text NOT NULL,
	"commit_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entity_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" text NOT NULL,
	"commit_id" uuid NOT NULL,
	"op" text NOT NULL,
	"type" text NOT NULL,
	"code" text NOT NULL,
	"short_title" text NOT NULL,
	"group" text NOT NULL,
	"tier" text NOT NULL,
	"title" text NOT NULL,
	"metadata_json" jsonb NOT NULL,
	"content_markdown" text NOT NULL,
	"flow_json" jsonb,
	"links_json" jsonb NOT NULL,
	"author" text DEFAULT 'local' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "head_entities" (
	"branch_id" uuid NOT NULL,
	"entity_id" text NOT NULL,
	"commit_id" uuid NOT NULL,
	"type" text NOT NULL,
	"code" text NOT NULL,
	"short_title" text NOT NULL,
	"group" text NOT NULL,
	"tier" text NOT NULL,
	"title" text NOT NULL,
	"metadata_json" jsonb NOT NULL,
	"content_markdown" text NOT NULL,
	"flow_json" jsonb,
	"links_json" jsonb NOT NULL,
	"author" text DEFAULT 'local' NOT NULL,
	CONSTRAINT "head_entities_branch_id_entity_id_pk" PRIMARY KEY("branch_id","entity_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "head_relations" (
	"branch_id" uuid NOT NULL,
	"relation_id" text NOT NULL,
	"commit_id" uuid NOT NULL,
	"source_entity_id" text NOT NULL,
	"target_entity_id" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"author" text DEFAULT 'local' NOT NULL,
	CONSTRAINT "head_relations_branch_id_relation_id_pk" PRIMARY KEY("branch_id","relation_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "relation_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"relation_id" text NOT NULL,
	"commit_id" uuid NOT NULL,
	"op" text NOT NULL,
	"source_entity_id" text NOT NULL,
	"target_entity_id" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"author" text DEFAULT 'local' NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commits" ADD CONSTRAINT "commits_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entity_versions" ADD CONSTRAINT "entity_versions_commit_id_commits_id_fk" FOREIGN KEY ("commit_id") REFERENCES "public"."commits"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "relation_versions" ADD CONSTRAINT "relation_versions_commit_id_commits_id_fk" FOREIGN KEY ("commit_id") REFERENCES "public"."commits"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
