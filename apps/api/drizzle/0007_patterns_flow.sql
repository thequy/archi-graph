-- Add an optional react-flow concept example to the global pattern catalog.
-- Nullable jsonb, additive — safe on existing rows (GoF patterns may stay null;
-- system-design patterns get a flow via the seed upsert at bootstrap).
ALTER TABLE "patterns" ADD COLUMN IF NOT EXISTS "flow_json" jsonb;
