import { type ClaimPreview, type MgmtApi, PLAN_RANK } from "../mgmt.ts";

/**
 * `claim` — move an existing project INTO a different organization via a claim
 * token (the org-level migration primitive). Distinct from the logical-
 * replication path: no new project, no data copy, just a token claim.
 *
 * IMPORTANT — org limits of the Management API: org settings, members/roles,
 * and entitlements are READ-ONLY (no write endpoint). claim moves the project;
 * it does NOT carry the team across. Members must be re-invited on the target
 * org by hand. A plan downgrade (e.g. team → free) silently disables features
 * (read replicas, PITR, larger compute) — surfaced here as a warning.
 */

export interface ClaimVerdict {
  /** true only if there are no hard blockers. */
  ok: boolean;
  /** Hard blockers — claim must NOT proceed. */
  blockers: string[];
  /** Non-blocking concerns — surfaced loudly; require --confirm to override. */
  warnings: string[];
}

/**
 * Pure gate over the claim preview. Exported for tests — the verdict must be
 * deterministic and fail CLOSED (an unparseable / invalid preview blocks).
 */
export function evaluateClaimPreview(
  p: ClaimPreview,
  opts: { expiresAt?: string; now?: number } = {},
): ClaimVerdict {
  const now = opts.now ?? Date.now();
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (
    opts.expiresAt &&
    Number.isFinite(Date.parse(opts.expiresAt)) &&
    Date.parse(opts.expiresAt) <= now
  ) {
    blockers.push(`claim token expired at ${opts.expiresAt}`);
  }
  for (const e of p.errors ?? []) blockers.push(`error: ${e.key} — ${e.message}`);
  // The API's own valid flag is authoritative even if no explicit error row.
  if (!p.valid) blockers.push("API marked the claim preview as not valid");

  for (const w of p.warnings ?? []) warnings.push(`${w.key} — ${w.message}`);
  for (const m of p.members_exceeding_free_project_limit ?? []) {
    warnings.push(`member over free-tier project limit: ${m.name} (limit ${m.limit})`);
  }
  // Plan downgrade: target plan ranks below source plan → features lost.
  const sRank = PLAN_RANK[p.source_subscription_plan];
  const tRank = PLAN_RANK[p.target_subscription_plan];
  if (sRank !== undefined && tRank !== undefined && tRank < sRank) {
    warnings.push(
      `plan DOWNGRADE ${p.source_subscription_plan} → ${p.target_subscription_plan} — ` +
        "read replicas / PITR / larger compute may be disabled on the target org",
    );
  }

  return { ok: blockers.length === 0, blockers, warnings };
}

export interface ClaimResult {
  ok: boolean;
  claimed: boolean;
  verdict: ClaimVerdict;
}

export async function claim(
  api: MgmtApi,
  log: typeof import("../log.ts").log,
  opts: { slug: string; token: string; confirm: boolean },
): Promise<ClaimResult> {
  log.step(`claim project → org ${opts.slug}${opts.confirm ? "" : " (preview only)"}`);

  const { status, body } = await api.getClaimPreview(opts.slug, opts.token);
  if (status !== 200 || !body) {
    log.err(
      `claim preview failed (HTTP ${status}) — bad slug/token, or no access to org ${opts.slug}`,
    );
    return {
      ok: false,
      claimed: false,
      verdict: { ok: false, blockers: ["preview unavailable"], warnings: [] },
    };
  }

  const { project, preview, expires_at, created_by } = body;
  log.info(`project ${project.name} (${project.ref})`);
  log.detail(`token created by ${created_by}, expires ${expires_at}`);
  log.detail(`plan ${preview.source_subscription_plan} → ${preview.target_subscription_plan}`);
  for (const i of preview.info ?? []) log.detail(`info: ${i.key} — ${i.message}`);

  const verdict = evaluateClaimPreview(preview, { expiresAt: expires_at });
  for (const w of verdict.warnings) log.warn(w);
  for (const b of verdict.blockers) log.err(b);

  if (!verdict.ok) {
    log.err(`claim BLOCKED — ${verdict.blockers.length} blocker(s). Resolve them and retry.`);
    return { ok: false, claimed: false, verdict };
  }

  if (!opts.confirm) {
    const warnNote = verdict.warnings.length ? ` (${verdict.warnings.length} warning(s))` : "";
    log.ok(`preview OK${warnNote}. Re-run with --confirm to perform the claim.`);
    log.warn("Members + roles do NOT transfer — re-invite the team on the target org by hand.");
    return { ok: true, claimed: false, verdict };
  }

  const res = await api.claimProject(opts.slug, opts.token);
  if (res.status >= 200 && res.status < 300) {
    log.ok(`project ${project.ref} claimed into org ${opts.slug} (HTTP ${res.status})`);
    log.warn("Members + roles did NOT transfer — re-invite the team on the target org by hand.");
    return { ok: true, claimed: true, verdict };
  }
  log.err(`claim POST failed (HTTP ${res.status}): ${res.text.slice(0, 300)}`);
  return { ok: false, claimed: false, verdict };
}
