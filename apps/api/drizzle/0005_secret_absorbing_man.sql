ALTER TABLE "entity_versions" ADD COLUMN "applies_patterns_json" jsonb;--> statement-breakpoint
ALTER TABLE "head_entities" ADD COLUMN "applies_patterns_json" jsonb;