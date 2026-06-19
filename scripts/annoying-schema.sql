DROP TABLE IF EXISTS public.events CASCADE;
DROP TABLE IF EXISTS public.documents CASCADE;
DROP TABLE IF EXISTS public.audit  CASCADE;
DROP TABLE IF EXISTS public.users  CASCADE;
DROP TYPE  IF EXISTS doc_status  CASCADE;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE TYPE doc_status AS ENUM ('active','archived','flagged','deleted');
CREATE TABLE public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  n int UNIQUE NOT NULL,
  email citext UNIQUE NOT NULL,
  display_name text,
  metadata jsonb NOT NULL DEFAULT '{}',
  tags text[] NOT NULL DEFAULT '{}',
  balance numeric(20,8) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.documents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner uuid REFERENCES public.users(id),
  title text,
  content text NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content,''))) STORED,
  blob bytea, status doc_status NOT NULL DEFAULT 'active',
  views int NOT NULL DEFAULT 0, ratio double precision, ttl interval, ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.events (
  document_id bigint NOT NULL REFERENCES public.documents(id),
  seq int NOT NULL, kind text NOT NULL, data jsonb, at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, seq)
);
CREATE TABLE public.audit (actor uuid, action text NOT NULL, detail text, at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.audit REPLICA IDENTITY FULL;
