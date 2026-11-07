-- Apply as schema owner after migrations 001 and 002, with application traffic
-- paused. Preserve actor identities and all facts/history/audit/creation receipts.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = pg_catalog, public;
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('memz-migration-003',0));
LOCK TABLE public.memberships IN ACCESS EXCLUSIVE MODE;
ALTER TABLE public.memberships ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
-- Do not silently adopt or rewrite a pre-existing, incompatible imported field.
-- Repeated runs must retain explicit false tombstones and the original role.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='public.memberships'::pg_catalog.regclass AND a.attname='active'
      AND a.attnum>0 AND NOT a.attisdropped AND a.atttypid='pg_catalog.bool'::pg_catalog.regtype
      AND a.attgenerated='' AND a.attidentity=''
      AND a.attnotnull AND pg_catalog.pg_get_expr(d.adbin,d.adrelid)='true'
  ) THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Membership activation prerequisites do not match';
  END IF;
END
$$;
CREATE OR REPLACE FUNCTION public.member_role(p int) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$SELECT role FROM public.memberships WHERE project_id=p AND user_id=nullif(pg_catalog.current_setting('app.user_id',true),'')::pg_catalog.int4 AND active IS TRUE$$;
COMMENT ON FUNCTION public.member_role(integer) IS 'memz:member-role-active-v1';
COMMIT;
