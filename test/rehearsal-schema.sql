-- Example-app-shaped schema for the scale rehearsal. Loaded on BOTH the source
-- and the target (logical replication does not create tables on the subscriber).
-- Mirrors migrate.config.example.yaml columns + the four gotchas the annoying
-- integration schema exercises, so the rehearsal validates the same code paths:
--   L-9: was missing IDENTITY pk, FKs, composite PK, and no-PK table.

CREATE TABLE IF NOT EXISTS public.documents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid,
  content             text,
  title               text,
  language            text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz,
  updated_at          timestamptz,
  visibility          text,
  archived  boolean,
  read_count          integer,
  is_encrypted        boolean,
  view_limit          integer,
  version             integer,
  ref_token        text,
  search_vector       tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content, ''))) STORED
);

CREATE TABLE IF NOT EXISTS public.aliases (
  alias        text PRIMARY KEY,
  document_id    uuid REFERENCES public.documents(id),  -- FK -> documents
  expires_at  timestamptz
);

-- IDENTITY pk: exercises the cutover sequence-resync code path.
CREATE TABLE IF NOT EXISTS public.items (
  id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title text
);

-- Composite PK: exercises the multi-column key hash path in reconcile.
CREATE TABLE IF NOT EXISTS public.tags (
  document_id uuid    NOT NULL REFERENCES public.documents(id),
  tag      text    NOT NULL,
  PRIMARY KEY (document_id, tag)
);

-- No-PK table: must use REPLICA IDENTITY FULL for UPDATE/DELETE replication.
CREATE TABLE IF NOT EXISTS public.audit_log (
  actor_ip inet,
  action   text NOT NULL,
  at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_log REPLICA IDENTITY FULL;
