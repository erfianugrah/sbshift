# Migration scope — the exhaustive list

Supabase has **three** official project-to-project guides, each with a different
take and a different vague "some things are not stored in your database" list:

| Guide | Mechanism | Status |
|---|---|---|
| [Dashboard restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/dashboard-restore) | logical `*.backup` → `psql` | legacy (older projects on logical backups) |
| [CLI backup/restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore) | `supabase db dump` `*.sql` → `psql` | current for self-driven dump/restore |
| [Restore to a new project (clone)](https://supabase.com/docs/guides/platform/clone-project) | physical backup / PITR, fully automated | current for paid + physical backups |

This document consolidates all three **plus the Management-API surface** into a
single scope. `pgshift` adds a fourth mechanism — **near-zero-downtime logical
replication** — which carries the same in-DB data as a dump but, like every
other method, carries **none** of the non-database artifacts. Those are the
"some things" each guide hand-waves at; they are enumerated below in full.

The clone guide automates the most: its physical-backup path replicates **compute
size, disk attributes, SSL enforcement, network restrictions** plus data+auth+roles,
and lists what it still leaves behind. pgshift's logical-replication path carries
*less* automatically (row data only), so the manual surface is *larger* — which is
why the `config-sync` / `provision` / `verify` / `claim` commands exist.

---

## A. Carried by the database itself (dump/restore, clone, OR pgshift replication)

These live in Postgres, so any data-plane method moves them — but with caveats.

| Artifact | Carrier | Caveat |
|---|---|---|
| Schema (tables, views, functions, procedures, triggers) | `schema.sql` / clone | pgshift logical repl carries **data only** — `bootstrap` loads schema first (pre-step). For a Supabase source it excludes the ~27 managed schemas (`auth`/`storage`/`extensions`/…) AND filters cluster objects a plain dump still emits (event triggers, `supabase_realtime` pub, `COMMENT ON EXTENSION`, `SET transaction_timeout`) that would abort the restore as non-superuser `postgres` — same as `supabase db dump`; `--all-schemas` forces a full dump |
| Table data + indexes | `data.sql` / clone / **pgshift replicate** | — |
| RLS policies | part of schema | `verify` asserts they're enabled on the target post-cutover |
| DB roles, permissions, users | `bootstrap` (`pg_dumpall --roles-only --no-role-passwords`) / clone | **custom LOGIN roles lose passwords** — reset by hand (`ALTER USER … WITH PASSWORD`). For a Supabase source, `bootstrap` filters out the reserved roles (`anon`/`authenticated`/`supabase_*`/`postgres`/…) the same way `supabase db dump --role-only` does — only your app roles restore |
| Auth user data (`auth` schema: accounts, hashed passwords) | `auth.sql` data dump / clone | pgshift: dump+restore `auth` BEFORE replicate (the `auth.users` FK trap) |
| Sequences | DDL in schema | **values don't replicate** → pgshift `cutover` resyncs every owned sequence |
| `supabase_migrations` schema (CLI migration history) | only if you dump it **separately** | `supabase db dump --schema supabase_migrations` (schema + data) |
| `auth` / `storage` schema customizations (your triggers, RLS) | only if diffed separately | `supabase db diff --schema auth,storage` then apply |
| Generated columns (e.g. STORED tsvector) | recomputed on target | excluded from pgshift's reconcile hash (hashing them = false mismatch) |

## B. In-DB but needs explicit handling

| Artifact | What to do | Gotcha |
|---|---|---|
| Extensions (enabled state) | `bootstrap` enables them on target before schema load | `doctor` diffs source vs target and prints the `CREATE EXTENSION` statements |
| `pg_net` / `pg_cron` / `wrappers` / external-effect extensions | re-enable, then **disable on the clone until ready** | clone guide warns these fire external actions immediately on the copy |
| Database Webhooks | re-enable in dashboard | implemented as `pg_net` triggers — schema carries the trigger, but `pg_net` must be on |
| `pgsodium` root key / column encryption | copy via API **only if you use column encryption / Vault** | `GET→PUT /pgsodium` (the CLI guide shows this exact pipe). Copying it onto a project that does NOT share the encrypted data makes that data undecryptable — only copy when migrating the encrypted columns too |
| Custom Postgres config via `ALTER ROLE/DATABASE … SET` | re-apply by hand | **invisible to config-sync** (lives in `pg_db_role_setting`); `doctor` detects + warns, flags compute-tuned ones |

## C. NOT in the database — the "some things" (exhaustive)

Every guide lists a *subset*; this is the union, with the carrier and the
pgshift command for each.

| # | Artifact | pgshift | Endpoint / tool | Gotcha |
|---|---|---|---|---|
| 1 | Edge Functions (code) | `functions` | `supabase functions download/deploy` | import maps + `deno.json` are **not** downloaded — re-add by hand |
| 2 | Edge Function / project secrets (env) | `config-sync` (`projectSecrets`, opt-in) | `GET/POST /secrets` | plaintext; dry-run redacts |
| 3 | Auth settings (providers, SMTP host, hooks, rate limits, redirect URLs) | `config-sync` (`auth`) | `/config/auth` | — |
| 4 | Auth **integration** secrets (SMTP pass, OAuth client secrets, SMS tokens, hook secrets) | `config-sync` (`secrets`, opt-in) | `/config/auth` | off by default |
| 5 | **JWT signing secret + API keys (anon/service)** | **never** | — | new project = new keys **by design**; all sessions invalidate, app must re-key + users re-login |
| 6 | Realtime settings | `config-sync` (`realtime`) | `/config/realtime` | — |
| 7 | Realtime **publications** (which tables broadcast) | manual | dashboard → Database → Publications | re-enable per table |
| 8 | PostgREST / Data API settings | `config-sync` (`postgrest`) | `/postgrest` | — |
| 9 | Storage config (file size limit, etc.) | `config-sync` (`storage`) | `/config/storage` | — |
| 10 | Storage buckets (configs) | metadata via dump; objects step below | `/storage/buckets` | bucket rows come with the DB dump |
| 11 | **Storage objects (actual S3 files)** | `storage` | JS copy script / Colab | the dump carries bucket+file *metadata* but **not the bytes** |
| 12 | Postgres config (API-exposed GUCs) | `config-sync` (`dbPostgres`, opt-in) | `/config/database/postgres` | only the API-exposed subset (see B for the SQL-level ones) |
| 13 | Pooler (Supavisor) config | `config-sync` (`dbPooler`) | `/config/database/pgbouncer` | — |
| 14 | Compute instance size | `provision` (`compute`) | `PATCH /billing/addons` | **billable**; under-provisioning the target risks cutover load |
| 15 | Disk attributes (size/iops/throughput/type) | `provision` (`disk`) | `POST /config/disk` | **billable**; size only grows |
| 16 | SSL enforcement | `config-sync` (`sslEnforcement`, opt-in) | `PUT /ssl-enforcement` | clone does this automatically |
| 17 | Network restrictions (allowed CIDRs) | `config-sync` (`networkRestrictions`, opt-in) | `POST /network-restrictions/apply` | empty source = skip (no accidental open) |
| 18 | PITR / backup schedule | `provision` (`pitr` / `backupSchedule`) | `/billing/addons`, `/database/backups/schedule` | schedule needs Enterprise plan |
| 19 | Dedicated IPv4 addon | `provision` (`ipv4`) | `PATCH /billing/addons` | **billable** |
| 20 | Read replicas | **manual** | `POST /read-replicas/setup` | no clean source-enumeration endpoint; recreate post-cutover |
| 21 | Custom domain / vanity subdomain | **manual** | `/custom-hostname/*`, `/vanity-subdomain/*` | DNS-coupled (CNAME + TXT verify) |

## D. Org-level / account (NOT migratable at all)

The Management API exposes these **read-only** — no write endpoint exists.

| Artifact | Why not migratable |
|---|---|
| Org settings (plan, AI opt-in tags, release channels) | `GET`-only; plan is billing-managed |
| Org members + roles | `GET /organizations/{slug}/members` only — re-invite by hand |
| Entitlements (compute availability, HA, read-replica eligibility) | derived from the target org's plan |

The only org-level *action* is **claiming a project into a different org**
(`pgshift claim`) — see [project transfers](https://supabase.com/docs/guides/platform/project-transfer).

---

## Dashboard section-by-section map

Even Supabase→Supabase is not "click clone and done". Walking the dashboard nav, here is every
settings surface, the API endpoint behind it, and who owns it on a migration. `✅` = automated by
a pgshift command; `🟡` = opt-in flag; `✋` = manual; `🚫` = never / not migratable.

### Project Settings (`/settings/*`)

| Dashboard page | Contains | Endpoint | Owner |
|---|---|---|---|
| General | Project name | `PATCH /v1/projects/{ref}` (name only) | ✋ cosmetic — set at target creation |
| General | Project ref, region | — | 🚫 immutable; region is chosen when you create the target |
| Compute and Disk | Compute size | `PATCH /billing/addons` | ✅ `provision` (`compute`) |
| Compute and Disk | Disk size/iops/throughput/type | `POST /config/disk` | ✅ `provision` (`disk`) |
| Infrastructure | Read replicas | `POST /read-replicas/setup` | ✋ no source-enumerate API — recreate post-cutover |
| Add Ons | PITR | `PATCH /billing/addons` | ✅ `provision` (`pitr`) |
| Add Ons | IPv4 | `PATCH /billing/addons` | ✅ `provision` (`ipv4`) |
| Add Ons | Custom domain | `/custom-hostname/*` | ✋ DNS-coupled |
| Data API | API URL | — | 🚫 new per project (auto) |
| Data API | anon / service_role keys | `GET /api-keys` | 🚫 NEW keys by design — re-key the app |
| Data API | JWT settings (expiry) | `/config/auth` (`jwt_exp`) | ✅ `config-sync` (`auth`) |
| Data API | Exposed schemas, search path, max rows | `/postgrest` | ✅ `config-sync` (`postgrest`) |
| Integrations | Vercel / GitHub / etc. | — | ✋ external OAuth installs — re-connect by hand |
| Vault | Secrets (encrypted) | in-DB + `/pgsodium` | ✋ data via dump; key only if column-encryption |
| Log Drains | Drain destinations | (no core endpoint) | ✋ re-create by hand |

### Database Settings (`/database/settings`, `/database/*`)

| Dashboard page | Contains | Endpoint | Owner |
|---|---|---|---|
| Settings | Connection string / host / port | — | 🚫 new per project |
| Settings | Database password | — | ✋ set new on target |
| Settings | Connection pooling (Supavisor: mode, size) | `/config/database/pgbouncer` | ✅ `config-sync` (`dbPooler`) |
| Settings | SSL enforcement | `PUT /ssl-enforcement` | 🟡 `config-sync` (`sslEnforcement`) |
| Settings | Network restrictions (allowed CIDRs) | `POST /network-restrictions/apply` | 🟡 `config-sync` (`networkRestrictions`) |
| Settings | Network bans (transient IP bans) | `/network-bans` | 🚫 transient — do not migrate |
| Settings | Disk size | `POST /config/disk` | ✅ `provision` (`disk`) |
| Postgres config | API-exposed GUCs | `/config/database/postgres` | 🟡 `config-sync` (`dbPostgres`) |
| Postgres config | `ALTER ROLE/DATABASE SET` overrides | `pg_db_role_setting` (SQL) | ✋ `doctor` detects; re-apply by hand |
| Tables/Functions/Triggers/Types/Indexes/Roles | schema | dump / replicate | ✅ pre-step (roles passwords ✋) |
| Webhooks | `pg_net` triggers | dashboard / schema | ✋ enable `pg_net` + re-enable hooks |
| Publications | Realtime publications | dashboard | ✋ re-enable per table |
| Backups | Schedule (Enterprise) | `PATCH /database/backups/schedule` | 🟡 `provision` (`backupSchedule`) |
| Migrations | `supabase_migrations` history | separate dump | ✋ dump that schema explicitly |

### Auth (`/auth/*`) — almost everything, with three exceptions

The single `/config/auth` blob (config-sync `auth`) covers **most** of the Auth nav:

| Auth dashboard section | In `/config/auth`? |
|---|---|
| Providers (email/phone/all OAuth) + their secrets | ✅ (`secrets` opt-in for the client secrets) |
| URL Configuration (site URL, redirect allow-list) | ✅ |
| Email Templates | ✅ |
| SMTP settings | ✅ (`secrets` opt-in for the password) |
| Rate Limits | ✅ |
| Attack Protection (CAPTCHA) | ✅ (`secrets` opt-in) |
| Auth Hooks | ✅ (`secrets` opt-in) |
| MFA settings | ✅ |
| Sessions (timeouts, refresh rotation) | ✅ |
| Advanced (JWT expiry, signup toggles) | ✅ |
| Users (accounts, hashed passwords) | data — dump/replicate the `auth` schema |

**But three Auth sub-resources are SEPARATE endpoints the blob does NOT carry:**

| Auth sub-resource | Endpoint | Migratable? | Owner |
|---|---|---|---|
| **Third-Party Auth** (Firebase/Auth0/Cognito/Clerk JWT) | `GET/POST/DELETE /config/auth/third-party-auth` | ✅ yes | 🟡 `config-sync` (`thirdPartyAuth`) |
| **SSO / SAML providers** | `GET/POST/PUT/DELETE /config/auth/sso/providers` | ✅ yes (entity_id, metadata, domains, attribute_mapping) | 🟡 `config-sync` (`ssoProviders`) |
| **Signing keys** (asymmetric JWT) | `/config/auth/signing-keys` | 🚫 don't copy | new project mints its own; app points at the new JWKS |

So: config-sync `auth` (blob) + `thirdPartyAuth` + `ssoProviders` together cover the **entire**
Auth surface except signing keys (deliberately never copied) and users (data — dump/replicate).
Both sub-resource syncs are **additive** (create-missing, keyed by issuer/JWKS url and SAML
entity_id respectively) and opt-in; SSO needs SAML 2.0 enabled on the target plan (handled: a
source 404 = SAML off = skip; a target 404 on POST = enable SAML on the target first).

### Other product areas

| Area | Item | Owner |
|---|---|---|
| Edge Functions | code | ✅ `functions` |
| Edge Functions | secrets (env) | 🟡 `config-sync` (`projectSecrets`) |
| Storage | bucket configs | ✅ metadata via dump |
| Storage | objects (S3 bytes) | ✅ `storage` |
| Storage | settings (size limit, image transform) | ✅ `config-sync` (`storage`) |
| Storage | S3 access keys | 🚫 new — generate on target |
| Realtime | settings | ✅ `config-sync` (`realtime`) |
| Realtime | publications | ✋ re-enable per table |

## pgshift coverage at a glance

```
In-DB data ............ replicate + watch + reconcile + cutover  (zero-downtime)
Schema/roles/exts ..... bootstrap    (pg_dumpall/pg_dump/psql; confirm-gated; doctor diffs first)
Auth/storage row data . dump/restore MANUAL (the auth.users FK trap; doctor prints the command)
Project config ........ config-sync  (auth, realtime, postgrest, storage, pooler,
                                      dbPostgres, +sslEnforcement +networkRestrictions opt-in)
Integration secrets ... config-sync  (secrets / projectSecrets — opt-in, never JWT/API keys)
Billable infra ........ provision    (compute, disk, pitr, ipv4, backupSchedule — confirm-gated)
Edge Functions ........ functions
Storage objects ....... storage
Health gate ........... verify       (advisors: RLS/PK/etc.)
Invisible SQL GUCs .... doctor       (pg_db_role_setting — detect + warn, manual re-apply)
Auth sub-resources .... config-sync  (thirdPartyAuth, ssoProviders — opt-in, additive)
Org move .............. claim
NEVER ................. JWT secret, API keys, auth signing keys, org settings/members/roles
MANUAL ................ read replicas, custom domain, realtime publications,
                        custom role passwords, supabase_migrations history,
                        auth/storage schema customizations, pgsodium (unless column-encryption)
```
