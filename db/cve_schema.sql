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
-- A current-record projection for lazy tree navigation. Original observations stay immutable.
-- Classification is explicit navigation policy, never evidence of affectedness.
CREATE OR REPLACE FUNCTION cve.facets_for(document jsonb)
RETURNS TABLE(stack text, service text, vendor text, product text, ecosystem text, cwe text)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
  WITH products AS (
    SELECT DISTINCT
      CASE WHEN length(a->>'vendor') BETWEEN 1 AND 300 THEN lower(btrim(a->>'vendor')) ELSE '' END vendor,
      CASE WHEN length(COALESCE(a->>'product',a->'package'->>'name')) BETWEEN 1 AND 300
        THEN lower(btrim(COALESCE(a->>'product',a->'package'->>'name'))) ELSE '' END product,
      CASE WHEN length(a->'package'->>'ecosystem') BETWEEN 1 AND 300
        THEN lower(btrim(a->'package'->>'ecosystem')) ELSE '' END ecosystem
    FROM jsonb_array_elements(CASE WHEN jsonb_array_length(document->'affected') > 0
      THEN document->'affected' ELSE '[{}]'::jsonb END) a
  ), weaknesses AS (
    SELECT DISTINCT value cwe FROM jsonb_array_elements_text(document->'cwes')
      WHERE value ~ '^CWE-[0-9]{1,10}$'
  )
  SELECT CASE
    WHEN product IN ('nginx','nginx open source','openresty','http_server','apache http server','apache httpd','httpd','iis','haproxy') THEN 'web'
    WHEN product IN ('mysql','mariadb','postgresql','postgres','sqlite','sql server','sql_server','microsoft sql server','oracle database') THEN 'sql'
    WHEN ecosystem = 'maven' OR product IN ('log4j','log4j-core','org.apache.logging.log4j:log4j-core','tomcat','spring framework') THEN 'java'
    WHEN ecosystem = 'npm' THEN 'javascript'
    WHEN ecosystem = 'pypi' THEN 'python'
    ELSE 'other' END,
    encode(sha256(convert_to(jsonb_build_array(vendor,product,ecosystem)::text,'UTF8')),'hex'),
    vendor,product,ecosystem,COALESCE(w.cwe,'unclassified')
  FROM products LEFT JOIN weaknesses w ON true
$fn$;
CREATE TABLE IF NOT EXISTS cve.facets (
  source text NOT NULL,
  source_id text NOT NULL,
  cve_id text NOT NULL,
  observation_id bigint NOT NULL,
  state text NOT NULL,
  stack text NOT NULL,
  service text NOT NULL CHECK (service ~ '^[a-f0-9]{64}$'),
  vendor text NOT NULL,
  product text NOT NULL,
  ecosystem text NOT NULL,
  cwe text NOT NULL,
  PRIMARY KEY (source,source_id,cve_id,service,cwe),
  FOREIGN KEY (source,source_id,cve_id) REFERENCES cve.records(source,source_id,cve_id) ON DELETE CASCADE,
  FOREIGN KEY (observation_id,source,source_id,cve_id) REFERENCES cve.observations(id,source,source_id,cve_id)
);
ALTER TABLE cve.facets ADD COLUMN IF NOT EXISTS state text;
UPDATE cve.facets f SET state=r.normalized->>'state' FROM cve.records r
  WHERE f.source=r.source AND f.source_id=r.source_id AND f.cve_id=r.cve_id
    AND f.state IS DISTINCT FROM r.normalized->>'state';
ALTER TABLE cve.facets ALTER COLUMN state SET NOT NULL;
CREATE INDEX IF NOT EXISTS cve_facets_tree ON cve.facets(stack,service,cwe,cve_id);
CREATE INDEX IF NOT EXISTS cve_facets_product ON cve.facets(product,vendor,cve_id);
CREATE INDEX IF NOT EXISTS cve_facets_cwe ON cve.facets(cwe,cve_id);
CREATE OR REPLACE FUNCTION cve.refresh_facets() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  DELETE FROM cve.facets WHERE source=NEW.source AND source_id=NEW.source_id AND cve_id=NEW.cve_id;
  INSERT INTO cve.facets(source,source_id,cve_id,observation_id,state,stack,service,vendor,product,ecosystem,cwe)
    SELECT NEW.source,NEW.source_id,NEW.cve_id,NEW.observation_id,NEW.normalized->>'state',f.* FROM cve.facets_for(NEW.normalized) f;
  RETURN NEW;
END
$fn$;
-- Invoker permissions: the ingest role needs explicit projection INSERT/DELETE grants.
CREATE OR REPLACE TRIGGER cve_refresh_facets AFTER INSERT OR UPDATE OF normalized,observation_id ON cve.records
  FOR EACH ROW EXECUTE FUNCTION cve.refresh_facets();
-- Backfill pre-tree databases without changing observations, records or source checkpoints.
INSERT INTO cve.facets(source,source_id,cve_id,observation_id,state,stack,service,vendor,product,ecosystem,cwe)
  SELECT r.source,r.source_id,r.cve_id,r.observation_id,r.normalized->>'state',f.*
  FROM cve.records r CROSS JOIN LATERAL cve.facets_for(r.normalized) f
  WHERE NOT EXISTS (SELECT 1 FROM cve.facets old WHERE old.source=r.source AND old.source_id=r.source_id AND old.cve_id=r.cve_id)
  ON CONFLICT DO NOTHING;
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
