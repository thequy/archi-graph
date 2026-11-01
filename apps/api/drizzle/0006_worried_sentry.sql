CREATE TABLE IF NOT EXISTS "patterns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"intent" text NOT NULL,
	"when_to_use" text NOT NULL,
	"pros" text NOT NULL,
	"cons" text NOT NULL,
	"mermaid" text,
	"kind" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patterns_slug_unique" UNIQUE("slug")
);
