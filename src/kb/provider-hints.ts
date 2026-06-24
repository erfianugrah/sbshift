import type { PgProvider } from "../db.ts";
import { type ProviderHintItem, ProviderHints } from "./schema.ts";

/**
 * Provider-specific logical-replication enablement knowledge — the data behind
 * `doctor`'s `providerHint`. Every target is native Postgres; only the *how-to-enable*
 * differs per managed provider. `supabase` (covered by the pooler/direct ladder) and
 * `generic` (self-hosted; the generic wal_level check suffices) intentionally have no
 * entries. Grounded in docs/GUIDED-MIGRATION.md §8 — keep `guidance` in sync with the
 * cited `provenance` via the planned `kb sync`.
 */
const RAW: ProviderHintItem[] = [
  {
    id: "rds-postgres.enable_logical_replication",
    provider: "rds-postgres",
    role: "source",
    severity: "info",
    klass: "informed",
    guidance:
      "RDS PostgreSQL: logical replication needs `rds.logical_replication=1` in a CUSTOM " +
      "parameter group. It is a STATIC parameter — the instance must be REBOOTED to apply " +
      "it (this sets wal_level=logical, max_wal_senders, max_replication_slots).",
    provenance: {
      source: "/docs/aws-rds/PostgreSQL.Concepts.General.FeatureSupport.LogicalReplication.md",
      lastSynced: "2026-06-24",
    },
  },
  {
    id: "aurora-postgres.enable_logical_replication",
    provider: "aurora-postgres",
    role: "source",
    severity: "info",
    klass: "informed",
    guidance:
      "Aurora PostgreSQL: set `rds.logical_replication=1` in the CLUSTER parameter group, then " +
      "reboot. Optional `aurora.enhanced_logical_replication=1` avoids needing REPLICA IDENTITY " +
      "FULL but INVALIDATES existing logical slots when toggled (recreate them) and raises IOPS.",
    provenance: {
      source: "/docs/aws-aurora/AuroraPostgreSQL.Replication.Logical.md",
      lastSynced: "2026-06-24",
    },
  },
  {
    id: "planetscale-postgres.direct_port_for_wal",
    provider: "planetscale-postgres",
    role: "source",
    severity: "info",
    klass: "informed",
    guidance:
      "PlanetScale Postgres: the subscription CONNECTION must use the DIRECT port 5432 — " +
      "port 6432 is PgBouncer and cannot stream WAL. Set logical-replication params in " +
      "Cluster > Parameters.",
    provenance: {
      source: "https://planetscale.com/docs/postgres/imports/postgres-migrate-walstream",
      lastSynced: "2026-06-24",
    },
  },
  {
    id: "planetscale-postgres.target_disk_and_copy_data",
    provider: "planetscale-postgres",
    role: "target",
    severity: "info",
    klass: "informed",
    guidance:
      "PlanetScale Postgres target: provision disk ≥150% of source size; after a manual " +
      "schema import, create the subscription with copy_data=false (and resync sequences).",
    provenance: {
      source: "https://planetscale.com/docs/postgres/imports/postgres-migrate-walstream",
      lastSynced: "2026-06-24",
    },
  },
  {
    id: "neon.enable_logical_replication",
    provider: "neon",
    role: "source",
    severity: "info",
    klass: "informed",
    guidance:
      "Neon: enabling logical replication is IRREVERSIBLE and restarts computes; " +
      "max_wal_senders/max_replication_slots are pinned at 10, and INACTIVE slots are dropped " +
      "after ~40h — a stalled migration loses its slot (the watch watchdog must catch this).",
    provenance: {
      source: "/docs/neon/logical-replication-in-neon.md",
      lastSynced: "2026-06-24",
    },
  },
  {
    id: "neon.target_no_scale_to_zero",
    provider: "neon",
    role: "target",
    severity: "info",
    klass: "informed",
    guidance:
      "Neon target: inbound logical replication (Neon as subscriber) is supported — ensure the " +
      "subscriber compute does not scale to zero mid-copy.",
    provenance: {
      source: "/docs/neon/logical-replication-in-neon.md",
      lastSynced: "2026-06-24",
    },
  },
  {
    id: "azure-postgres.enable_logical_replication",
    provider: "azure-postgres",
    role: "source",
    severity: "info",
    klass: "informed",
    guidance:
      "Azure Database for PostgreSQL: set server parameter `wal_level=logical` + restart; raise " +
      "max_replication_slots/max_wal_senders. PG17+ preserves slots across failover via " +
      "sync_replication_slots+hot_standby_feedback; PG≤16 needs the PG Failover Slots extension. " +
      "Unused slots are auto-dropped near 95% storage — keep the slot consumed.",
    provenance: {
      source: "https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-logical",
      lastSynced: "2026-06-24",
    },
  },
];

/** Validated at module load — a malformed KB entry crashes loudly, never silently skips. */
export const providerHints: readonly ProviderHintItem[] = ProviderHints.parse(RAW);

/**
 * The advisory guidance for a given provider acting in a given role, or null when there is
 * no item (supabase/generic, or a provider with only a source-role note queried for target).
 */
export function lookupProviderHint(provider: PgProvider, role: "source" | "target"): string | null {
  return providerHints.find((h) => h.provider === provider && h.role === role)?.guidance ?? null;
}
