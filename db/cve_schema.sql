-- Standalone, additive migration. Execute as a schema owner, never as Memz's app role.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(1734702693, 1);
CREATE SCHEMA IF NOT EXISTS cve;
REVOKE ALL ON SCHEMA cve FROM PUBLIC;
CREATE TABLE IF NOT EXISTS cve.observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('cvelist','nvd','ghsa','kev','circl')),
  source_id text NOT NULL,
  cve_id text NOT NULL CHECK (cve_id ~ '^CVE-[0-9]{4}-[0-9]{4,}$'),
  source_url text NOT NULL,
  source_modified timestamptz,
  fetched_at timestamptz NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  raw jsonb NOT NULL,
  normalized jsonb NOT NULL,
  UNIQUE (source, source_id, cve_id, sha256),
  UNIQUE (id, source, source_id, cve_id)
);
CREATE TABLE IF NOT EXISTS cve.records (
  source text NOT NULL,
  source_id text NOT NULL,
  cve_id text NOT NULL,
  observation_id bigint NOT NULL,
  normalized jsonb NOT NULL,
  last_seen timestamptz NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS
    (to_tsvector('simple'::regconfig, normalized->>'search_text')) STORED,
  PRIMARY KEY (source, source_id, cve_id),
  FOREIGN KEY (observation_id, source, source_id, cve_id)
    REFERENCES cve.observations(id, source, source_id, cve_id)
);
CREATE INDEX IF NOT EXISTS cve_records_id ON cve.records(cve_id);
CREATE INDEX IF NOT EXISTS cve_records_search ON cve.records USING gin(search_vector);
CREATE INDEX IF NOT EXISTS cve_records_fields ON cve.records USING gin(normalized jsonb_path_ops);
-- Keep the watermark even when a GHSA removes its final CVE alias.
CREATE TABLE IF NOT EXISTS cve.source_state (
  source text NOT NULL,
  source_id text NOT NULL,
  source_modified timestamptz,
  sha256 text NOT NULL,
  fetched_at timestamptz NOT NULL,
  PRIMARY KEY (source, source_id)
);
CREATE TABLE IF NOT EXISTS cve.checkpoints (
  name text PRIMARY KEY,
  cursor jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cve.sync_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL CHECK (status IN ('running','complete','failed')),
  counts jsonb NOT NULL DEFAULT '{}',
  error_code text
);
-- Shared public vulnerability knowledge has no dependency on project memory/RLS.
-- No grants to PUBLIC or memz_app; grant dedicated readers/writers explicitly.
COMMIT;
