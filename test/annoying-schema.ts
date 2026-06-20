/**
 * The scale/live HARNESS fixture, welded to the harness machinery: `documents`
 * is a bigint IDENTITY table (writer.ts inserts into it; the inflight-loss
 * ledger tracks `documents.id`) and `audit` is the no-PK churn table
 * (`auditChurn`). Used by:
 *   test/scale.harness.ts   — local Docker, 1M-row stress test
 *   test/live.harness.ts    — real Supabase throwaway pair
 *
 * The schema is deliberately adversarial: STORED generated column (CPU cost),
 * IDENTITY pk (owned sequence), COMPOSITE pk, NO-PK table (REPLICA IDENTITY
 * FULL), inter-table FKs, and every GUC-sensitive type that can produce
 * divergent row::text renders (numeric, float8, timestamptz, interval, inet,
 * bytea, jsonb, text[], citext, enum).
 *
 * INTENTIONALLY distinct from src/rehearsal/schema.sql, which is a DIFFERENT
 * schema (uuid `documents` + a separate `items` IDENTITY table) for the
 * `rehearse run` / `sandbox` / docker-rehearsal tier and is matched by
 * seed.ts's seed()/seedToSize(). Merging the two would force one documents
 * shape onto the other and require rewriting writer.ts + the ledger +
 * auditChurn — so they are kept separate on purpose, NOT accidental duplication.
 */
import type { Db } from "../src/db.ts";

export async function createSchema(db: Db): Promise<void> {
  await db.unsafe(`
    DROP TABLE IF EXISTS public.events CASCADE;
    DROP TABLE IF EXISTS public.documents CASCADE;
    DROP TABLE IF EXISTS public.audit  CASCADE;
    DROP TABLE IF EXISTS public.users  CASCADE;
    DROP TYPE  IF EXISTS doc_status  CASCADE;
    CREATE EXTENSION IF NOT EXISTS citext;
    CREATE TYPE doc_status AS ENUM ('active','archived','flagged','deleted');

    -- parent: uuid pk, citext unique, jsonb, array, numeric
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

    -- heavy child: IDENTITY pk (owned sequence), FK→users, STORED tsvector,
    -- bytea/numeric/float/interval/inet/enum + nullable columns + unicode content
    CREATE TABLE public.documents (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      owner uuid REFERENCES public.users(id),
      title text,
      content text NOT NULL,
      search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content,''))) STORED,
      blob bytea,
      status doc_status NOT NULL DEFAULT 'active',
      views int NOT NULL DEFAULT 0,
      ratio double precision,
      ttl interval,
      ip inet,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    -- composite pk + FK→documents
    CREATE TABLE public.events (
      document_id bigint NOT NULL REFERENCES public.documents(id),
      seq int NOT NULL,
      kind text NOT NULL,
      data jsonb,
      at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (document_id, seq)
    );

    -- NO pk → must use REPLICA IDENTITY FULL or UPDATE/DELETE won't replicate
    CREATE TABLE public.audit (
      actor uuid,
      action text NOT NULL,
      detail text,
      at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE public.audit REPLICA IDENTITY FULL;
  `);
}

export async function seedSource(db: Db, rows: number): Promise<void> {
  const N_USERS = Math.min(Math.max(Math.floor(rows / 10), 1_000), 50_000);
  const N_AUDIT = Math.max(Math.floor(rows / 10), 1_000);
  const BATCH = 50_000;

  await db.unsafe(
    `INSERT INTO public.users (n, email, display_name, metadata, tags, balance)
     SELECT g, 'user'||g||'@example.com',
            CASE WHEN g%7=0 THEN NULL ELSE 'Üsér '||g||' λ' END,
            jsonb_build_object('plan',(ARRAY['free','pro','team'])[1+g%3],'seq',g),
            ARRAY['t'||(g%5),'t'||(g%11)],
            (g*1.23456789)::numeric(20,8)
     FROM generate_series(1,$1::int) g`,
    [N_USERS],
  );

  for (let off = 0; off < rows; off += BATCH) {
    const n = Math.min(BATCH, rows - off);
    await db.unsafe(
      `WITH uids AS (SELECT array_agg(id ORDER BY n) AS a FROM public.users)
       INSERT INTO public.documents (owner,title,content,blob,status,views,ratio,ttl,ip)
       SELECT a[1+(g%$3)],
              CASE WHEN g%9=0 THEN NULL ELSE 'title '||g END,
              left(repeat(md5(random()::text),10),300)||' 日本語 '||g,
              decode(md5(g::text),'hex'),
              (ARRAY['active','archived','flagged','deleted']::doc_status[])[1+g%4],
              (g%1000),
              CASE WHEN g%5=0 THEN NULL ELSE random() END,
              ((g%48)||' hours')::interval,
              ('10.'||(g%256)||'.'||((g/256)%256)||'.'||(g%256))::inet
       FROM generate_series($1::bigint,$2::bigint) g, uids`,
      [off + 1, off + n, N_USERS],
    );
  }

  for (let off = 0; off < rows; off += BATCH) {
    const n = Math.min(BATCH, rows - off);
    await db.unsafe(
      `INSERT INTO public.events (document_id,seq,kind,data)
       SELECT g,1,(ARRAY['create','view','edit'])[1+g%3],
              jsonb_build_object('g',g,'ok',(g%2=0))
       FROM generate_series($1::bigint,$2::bigint) g`,
      [off + 1, off + n],
    );
  }

  await db.unsafe(
    `INSERT INTO public.audit (actor,action,detail)
     SELECT gen_random_uuid(),(ARRAY['login','delete','update'])[1+g%3],
            CASE WHEN g%3=0 THEN NULL ELSE 'detail '||g END
     FROM generate_series(1,$1::int) g`,
    [N_AUDIT],
  );
}
