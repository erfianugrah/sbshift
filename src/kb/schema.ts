import { z } from "zod";

/**
 * A unit of migration knowledge, promoted from inline control flow to validated data.
 *
 * This is the PG-family **provider-hint** slice of the broader `KnowledgeItem` proposed in
 * docs/GUIDED-MIGRATION.md §4: enough structure to carry `provenance` (so the planned
 * `kb drift` / `kb sync` loop in §6 can re-check the cited source) without the cross-engine
 * `phase` / `appliesTo{source,target}` fields the heterogeneous data plane (HETEROGENEOUS.md)
 * will add. Until then, a provider hint is keyed by `(provider, role)` — which managed
 * Postgres the connection points at, and whether it is the migration source or target.
 *
 * `severity` / `klass` are full enums (not the `info` / `informed` the current data happens
 * to use) so heterogeneous items reuse this schema rather than forcing a migration. See
 * docs/GUIDED-MIGRATION.md §8, §10.1.
 */
export const ProviderHintItem = z.object({
  /** Stable id, e.g. "rds-postgres.enable_logical_replication". */
  id: z.string().min(1),
  /** Managed-Postgres provider this guidance applies to (mirrors db.ts `PgProvider`). */
  provider: z.enum([
    "supabase",
    "rds-postgres",
    "aurora-postgres",
    "neon",
    "planetscale-postgres",
    "azure-postgres",
    "generic",
  ]),
  /** Whether the guidance applies when this provider is the migration source or target. */
  role: z.enum(["source", "target"]),
  /** fail gates a phase; warn/info are advisory. Provider hints are all `info` today. */
  severity: z.enum(["fail", "warn", "info"]),
  /** auto applies it; assisted/guided draft-then-ratify; informed prints + acks. */
  klass: z.enum(["auto", "assisted", "guided", "informed"]),
  /** The exact remediation text doctor prints (kept verbatim — tests assert substrings). */
  guidance: z.string().min(1),
  provenance: z.object({
    /** docs.erfi.io path (preferred — drift-checkable via docs_grep) or vendor URL. */
    source: z.string().min(1),
    /** ISO date (YYYY-MM-DD) the guidance was last reconciled against `source`. */
    lastSynced: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "lastSynced must be YYYY-MM-DD"),
  }),
});
export type ProviderHintItem = z.infer<typeof ProviderHintItem>;

/** A validated list of provider-hint knowledge items. */
export const ProviderHints = z.array(ProviderHintItem);
