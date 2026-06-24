import type { PgProvider } from "../db.ts";
import { log } from "../log.ts";
import { providerHints } from "./provider-hints.ts";
import type { ProviderHintItem } from "./schema.ts";

/**
 * The enablement playbook for one managed-Postgres provider, assembled from the KB.
 *
 * This is the offline, `informed`-class first form of `pgshift guide` (docs/GUIDED-MIGRATION.md
 * §5): it surfaces "what must I do to use provider X as a migration source / target" as an
 * ordered, provenance-stamped checklist a human can consult *before* they hold live
 * credentials. The live detect → compare → verify walk (for the `assisted`/`auto` checks
 * doctor runs against a connection) is a later layer that plugs into the same sections —
 * `doctor` remains the live-readiness command.
 *
 * Role maps to migration phase: a source-role item is `source-prep` (enable replication on
 * the source), a target-role item is `target-prep`.
 */
const ROLE_PHASE: Record<"source" | "target", string> = {
  source: "source-prep",
  target: "target-prep",
};

export interface GuideSection {
  role: "source" | "target";
  phase: string;
  items: ProviderHintItem[];
}

export interface Guide {
  provider: PgProvider;
  /** Only roles that have at least one item, source before target. */
  sections: GuideSection[];
  itemCount: number;
}

/** Provider ids that have at least one guide item (drives CLI validation + help). */
export function guidableProviders(
  items: readonly ProviderHintItem[] = providerHints,
): PgProvider[] {
  const seen = new Set<PgProvider>();
  for (const i of items) seen.add(i.provider);
  return [...seen];
}

export function buildGuide(
  provider: PgProvider,
  opts: { role?: "source" | "target"; items?: readonly ProviderHintItem[] } = {},
): Guide {
  const all = opts.items ?? providerHints;
  const roles: ("source" | "target")[] = opts.role ? [opts.role] : ["source", "target"];
  const sections: GuideSection[] = roles
    .map((role) => ({
      role,
      phase: ROLE_PHASE[role],
      items: all.filter((i) => i.provider === provider && i.role === role),
    }))
    .filter((s) => s.items.length > 0);
  return {
    provider,
    sections,
    itemCount: sections.reduce((n, s) => n + s.items.length, 0),
  };
}

/** Human-readable render of a guide via the structured logger. */
export function renderGuide(g: Guide): void {
  log.step(`guide: ${g.provider} (${g.itemCount} item${g.itemCount === 1 ? "" : "s"})`);
  if (g.itemCount === 0) {
    log.info(`no enablement items for '${g.provider}'`);
    return;
  }
  for (const section of g.sections) {
    log.info(`${g.provider} as ${section.role} — phase ${section.phase}:`);
    for (const item of section.items) {
      log.detail(`[${item.severity}/${item.klass}] ${item.id}`);
      log.detail(`  ${item.guidance}`);
      log.detail(`  source: ${item.provenance.source} (synced ${item.provenance.lastSynced})`);
    }
  }
  log.info("this is the enablement reference — run `pgshift doctor` for live readiness");
}
