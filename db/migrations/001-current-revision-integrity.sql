-- Run as the schema owner with psql -v ON_ERROR_STOP=1.
-- Supports the original schema and the strengthened fresh-install schema.
-- No business rows, sequences, grants, or policies are changed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = pg_catalog, public;
-- Serialize upgrades and prevent writes between validation and installation.
LOCK TABLE public.facts, public.revisions IN ACCESS EXCLUSIVE MODE;
-- This name also belongs to the fresh schema's existing UNIQUE index.
CREATE UNIQUE INDEX IF NOT EXISTS revisions_project_id_fact_id_version_id_key
  ON public.revisions(project_id,fact_id,version,id);
-- Reinstall the exact definitions rather than trusting constraint names alone.
ALTER TABLE public.facts DROP CONSTRAINT IF EXISTS facts_current_revision_fk;
ALTER TABLE public.facts DROP CONSTRAINT IF EXISTS facts_current_revision_state;
ALTER TABLE public.facts ADD CONSTRAINT facts_current_revision_fk
  FOREIGN KEY(project_id,id,version,current_revision_id)
  REFERENCES public.revisions(project_id,fact_id,version,id);
ALTER TABLE public.facts ADD CONSTRAINT facts_current_revision_state
  CHECK ((version=0 AND current_revision_id IS NULL)
      OR (version>0 AND current_revision_id IS NOT NULL));
-- The stronger key supersedes the original project's weaker pointer key.
ALTER TABLE public.facts DROP CONSTRAINT IF EXISTS facts_project_id_current_revision_id_fkey;
COMMIT;
