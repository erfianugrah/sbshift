import { type Config, supabaseSourceRef } from "../config.ts";
import { log } from "../log.ts";
import type { MgmtApi } from "../mgmt.ts";

/**
 * `provision` — copy the BILLABLE infrastructure tier SOURCE → TARGET: compute
 * instance size, PITR/IPv4 addons, disk attributes, backup schedule. Every one
 * of these changes the target's bill, so:
 *
 *   - preview by default; only `--confirm` mutates (mirrors `claim`/`cutover`);
 *   - each area is opt-in via `provision.*` config flags (all default false);
 *   - it ADDS/UPGRADES the target to match the source, never STRIPS addons the
 *     target already has (a downgrade is a separate, deliberate act).
 *
 * Deliberately NOT handled here (see RUNBOOK): custom-domain / vanity-subdomain
 * (DNS-coupled — needs verification steps), pgsodium root key (copying it makes
 * the target's Vault data undecryptable), read replicas (no clean source-side
 * enumeration endpoint), auth_mfa_phone addon.
 */

export type AddonType = "compute_instance" | "pitr" | "ipv4" | "custom_domain" | "auth_mfa_phone";

interface AddonPrice {
  amount?: number;
  interval?: string;
  type?: string;
}
interface AddonVariant {
  id: string;
  name?: string;
  price?: AddonPrice;
}
export interface SelectedAddon {
  type: AddonType;
  variant: AddonVariant;
}
interface AddonsResponse {
  selected_addons?: SelectedAddon[];
}
export interface DiskAttributes {
  iops?: number;
  size_gb?: number;
  throughput_mibps?: number;
  type?: string;
}

export function formatPrice(p?: AddonPrice): string {
  if (!p || typeof p.amount !== "number") return "price n/a";
  return `$${p.amount}/${p.interval ?? "?"}`;
}

/** The selected variant of a given addon type, or null if the project has none. */
export function selectedVariant(addons: SelectedAddon[], type: AddonType): AddonVariant | null {
  return addons.find((a) => a.type === type)?.variant ?? null;
}

export interface AddonChange {
  addon_type: AddonType;
  addon_variant: string;
  from: string | null;
  priceNote: string;
}

/**
 * Pure: for each enabled addon type, plan a PATCH if the source has it and the
 * target's variant differs. Never plans a removal. Exported for tests.
 */
export function planAddonChanges(
  src: SelectedAddon[],
  tgt: SelectedAddon[],
  enabled: AddonType[],
): AddonChange[] {
  const out: AddonChange[] = [];
  for (const type of enabled) {
    const s = selectedVariant(src, type);
    if (!s) continue; // source has no such addon → nothing to copy
    const t = selectedVariant(tgt, type);
    if (t?.id === s.id) continue; // already matches
    out.push({
      addon_type: type,
      addon_variant: s.id,
      from: t?.id ?? null,
      priceNote: formatPrice(s.price),
    });
  }
  return out;
}

export interface DiskPlan {
  change: boolean;
  from: DiskAttributes;
  to: DiskAttributes;
}

/** Pure: does the target disk differ from source? Exported for tests. */
export function planDisk(src: DiskAttributes, tgt: DiskAttributes): DiskPlan {
  const change =
    src.size_gb !== tgt.size_gb ||
    src.iops !== tgt.iops ||
    src.throughput_mibps !== tgt.throughput_mibps ||
    src.type !== tgt.type;
  return { change, from: tgt, to: src };
}

export interface ProvisionResult {
  ok: boolean;
  planned: number;
  applied: number;
}

export async function provision(
  api: MgmtApi,
  cfg: Config,
  opts: { confirm: boolean },
): Promise<ProvisionResult> {
  const sourceRef = supabaseSourceRef(cfg);
  log.step(`provision ${sourceRef} → ${cfg.target.ref}${opts.confirm ? "" : " (preview only)"}`);
  const p = cfg.provision;
  const result: ProvisionResult = { ok: true, planned: 0, applied: 0 };

  // ── addons: compute / pitr / ipv4 ──────────────────────────────────────
  const enabled: AddonType[] = [];
  if (p.compute) enabled.push("compute_instance");
  if (p.pitr) enabled.push("pitr");
  if (p.ipv4) enabled.push("ipv4");
  if (enabled.length > 0) {
    log.info("--- Addons (compute / pitr / ipv4) ---");
    const [srcA, tgtA] = await Promise.all([
      api.get<AddonsResponse>(sourceRef, "/billing/addons"),
      api.get<AddonsResponse>(cfg.target.ref, "/billing/addons"),
    ]);
    if (srcA.status !== 200 || !srcA.body || tgtA.status !== 200 || !tgtA.body) {
      log.warn(`addons GET failed (source ${srcA.status} / target ${tgtA.status}) — skipping`);
    } else {
      const changes = planAddonChanges(
        srcA.body.selected_addons ?? [],
        tgtA.body.selected_addons ?? [],
        enabled,
      );
      if (changes.length === 0) log.ok("addons already match source (or source has none)");
      for (const c of changes) {
        result.planned++;
        log.warn(
          `addon ${c.addon_type}: ${c.from ?? "(none)"} → ${c.addon_variant}  [${c.priceNote}] — BILLABLE`,
        );
        if (opts.confirm) {
          const res = await api.write(cfg.target.ref, "/billing/addons", "PATCH", {
            addon_type: c.addon_type,
            addon_variant: c.addon_variant,
          });
          if (res.status >= 200 && res.status < 300) {
            result.applied++;
            log.ok(`applied ${c.addon_type}=${c.addon_variant}`);
          } else {
            result.ok = false;
            log.err(`addon ${c.addon_type} failed (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
          }
        }
      }
    }
  }

  // ── disk attributes ────────────────────────────────────────────────────
  if (p.disk) {
    log.info("--- Disk attributes ---");
    const [srcD, tgtD] = await Promise.all([
      api.get<{ attributes?: DiskAttributes }>(sourceRef, "/config/disk"),
      api.get<{ attributes?: DiskAttributes }>(cfg.target.ref, "/config/disk"),
    ]);
    if (
      srcD.status !== 200 ||
      !srcD.body?.attributes ||
      tgtD.status !== 200 ||
      !tgtD.body?.attributes
    ) {
      log.warn(`disk GET failed (source ${srcD.status} / target ${tgtD.status}) — skipping`);
    } else {
      const plan = planDisk(srcD.body.attributes, tgtD.body.attributes);
      if (!plan.change) {
        log.ok(
          `disk already matches (${plan.to.type} ${plan.to.size_gb}GB / ${plan.to.iops} iops)`,
        );
      } else {
        result.planned++;
        log.warn(
          `disk: ${plan.from.type} ${plan.from.size_gb}GB/${plan.from.iops}iops → ` +
            `${plan.to.type} ${plan.to.size_gb}GB/${plan.to.iops}iops — BILLABLE`,
        );
        if (opts.confirm) {
          const res = await api.write(cfg.target.ref, "/config/disk", "POST", {
            attributes: plan.to,
          });
          if (res.status >= 200 && res.status < 300) {
            result.applied++;
            log.ok("disk applied");
          } else {
            result.ok = false;
            log.err(`disk POST failed (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
          }
        }
      }
    }
  }

  // ── backup schedule (Enterprise plan only) ─────────────────────────────
  if (p.backupSchedule) {
    log.info("--- Backup schedule ---");
    const srcS = await api.get<{ schedule_for?: string }>(sourceRef, "/database/backups/schedule");
    if (srcS.status === 402) {
      log.warn("backup schedule requires the Enterprise plan — skipping");
    } else if (srcS.status !== 200 || !srcS.body?.schedule_for) {
      log.warn(`backup schedule GET failed (HTTP ${srcS.status}) — skipping`);
    } else {
      result.planned++;
      log.warn(`backup schedule → ${srcS.body.schedule_for}`);
      if (opts.confirm) {
        const res = await api.write(cfg.target.ref, "/database/backups/schedule", "PATCH", {
          schedule_for: srcS.body.schedule_for,
        });
        if (res.status >= 200 && res.status < 300) {
          result.applied++;
          log.ok("backup schedule applied");
        } else {
          result.ok = false;
          log.err(`backup schedule PATCH failed (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
        }
      }
    }
  }

  if (result.planned === 0) {
    log.ok("provision: nothing to change (target already matches source for enabled areas)");
  } else if (!opts.confirm) {
    log.warn(
      `${result.planned} change(s) planned. Re-run with --confirm to apply — this CHANGES THE TARGET'S BILL.`,
    );
  }
  return result;
}
