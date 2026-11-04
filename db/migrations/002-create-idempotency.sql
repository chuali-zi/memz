-- Apply as schema owner after migration 001. Business rows are never rewritten.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('memz-migration-002',0));
CREATE TABLE IF NOT EXISTS public.idempotency_requests (
  project_id int NOT NULL REFERENCES public.projects(id),
  actor_id int NOT NULL,
  operation text NOT NULL CHECK(operation IN ('sources','candidates')),
  request_key text NOT NULL CHECK(request_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  response jsonb NOT NULL CHECK(jsonb_typeof(response)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,actor_id,operation,request_key),
  FOREIGN KEY(project_id,actor_id) REFERENCES public.memberships(project_id,user_id)
);
ALTER TABLE public.idempotency_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS idempotency_read ON public.idempotency_requests;
CREATE POLICY idempotency_read ON public.idempotency_requests FOR SELECT TO memz_app
  USING (actor_id=nullif(current_setting('app.user_id',true),'')::int
    AND public.member_role(project_id) IN ('owner','member'));
DROP POLICY IF EXISTS idempotency_insert ON public.idempotency_requests;
CREATE POLICY idempotency_insert ON public.idempotency_requests FOR INSERT TO memz_app
  WITH CHECK (actor_id=nullif(current_setting('app.user_id',true),'')::int
    AND public.member_role(project_id) IN ('owner','member'));
GRANT SELECT,INSERT ON public.idempotency_requests TO memz_app;
COMMIT;
