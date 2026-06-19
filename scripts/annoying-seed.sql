-- Seeds the annoying schema. Pass row count via:  psql -v rows=50000 -f annoying-seed.sql
-- users = rows/10 (min 1000), events = rows (1:1 with documents), audit = rows/10.
\set users :rows
INSERT INTO public.users (n, email, display_name, metadata, tags, balance)
SELECT g, 'user'||g||'@example.com',
       CASE WHEN g%7=0 THEN NULL ELSE 'Üsér '||g||' λ' END,
       jsonb_build_object('plan',(ARRAY['free','pro','team'])[1+g%3],'seq',g),
       ARRAY['t'||(g%5),'t'||(g%11)], (g*1.23456789)::numeric(20,8)
FROM generate_series(1, GREATEST((:rows)/10, 1000)::int) g;

INSERT INTO public.documents (owner, title, content, blob, status, views, ratio, ttl, ip)
SELECT (SELECT array_agg(id ORDER BY n) FROM public.users)[1+(g % GREATEST((:rows)/10,1000))],
       CASE WHEN g%9=0 THEN NULL ELSE 'title '||g END,
       left(repeat(md5(random()::text),10),300)||' 日本語 '||g,
       decode(md5(g::text),'hex'),
       (ARRAY['active','archived','flagged','deleted']::doc_status[])[1+g%4],
       (g%1000), CASE WHEN g%5=0 THEN NULL ELSE random() END,
       ((g%48)||' hours')::interval,
       ('10.'||(g%256)||'.'||((g/256)%256)||'.'||(g%256))::inet
FROM generate_series(1, (:rows)::bigint) g;

INSERT INTO public.events (document_id, seq, kind, data)
SELECT g,1,(ARRAY['create','view','edit'])[1+g%3], jsonb_build_object('g',g,'ok',(g%2=0))
FROM generate_series(1, (:rows)::bigint) g;

INSERT INTO public.audit (actor, action, detail)
SELECT gen_random_uuid(),(ARRAY['login','delete','update'])[1+g%3],
       CASE WHEN g%3=0 THEN NULL ELSE 'detail '||g END
FROM generate_series(1, GREATEST((:rows)/10,1000)::int) g;
