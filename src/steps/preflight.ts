import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import { log } from "../log.ts";

/** Read-only checks that must pass before we touch anything. Throws on hard failures. */
export async function preflight(source: Db, target: Db, cfg: Config): Promise<void> {
  log.step("preflight");
  let hardFail = false;

  // 1. Postgres versions
  const [srcV] = await source`SHOW server_version_num`;
  const [tgtV] = await target`SHOW server_version_num`;
  const srcNum = Number(srcV?.server_version_num ?? 0);
  const tgtNum = Number(tgtV?.server_version_num ?? 0);
  log.detail(`source PG ${srcNum} / target PG ${tgtNum}`);
  if (srcNum < 100000) {
    log.err("source is < PG10 — logical replication unavailable");
    hardFail = true;
  }
  if (tgtNum < srcNum) {
    log.warn(
      "target major version is older than source — logical replication may reject some types",
    );
  }

  // 2. wal_level on source
  const [wal] = await source`SHOW wal_level`;
  if (wal?.wal_level !== "logical") {
    log.err(`source wal_level=${wal?.wal_level} (need 'logical')`);
    hardFail = true;
  } else {
    log.ok("source wal_level=logical");
  }

  // 3. Target can CREATE SUBSCRIPTION (documented-supported, but verify the role grant).
  //    PG16+: needs pg_create_subscription membership; PG15: superuser.
  const [sub] = await target`
    SELECT
      (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super,
      pg_has_role(current_user, 'pg_create_subscription', 'MEMBER') AS has_grant`;
  const canSubscribe = sub?.is_super || sub?.has_grant;
  if (canSubscribe) {
    log.ok("target role can CREATE SUBSCRIPTION");
  } else if (tgtNum < 160000) {
    log.warn(
      "PG15 target + non-superuser role — CREATE SUBSCRIPTION may be blocked; smoke-test before relying on it",
    );
  } else {
    log.err("target role lacks pg_create_subscription membership");
    hardFail = true;
  }

  // 4. Every published table has a replica identity (PK / replica index / FULL).
  for (const qt of cfg.replication.tables) {
    const [schema, table] = qt.split(".");
    const [r] = await source`
      SELECT c.relreplident,
             EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary) AS has_pk
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${schema ?? ""} AND c.relname = ${table ?? ""}`;
    if (!r) {
      log.err(`published table ${qt} not found on source`);
      hardFail = true;
      continue;
    }
    // relreplident: d=default(uses PK), f=full, i=index, n=nothing.
    // A PK existing is NOT enough — if relreplident='n' there is no replica
    // identity even with a PK present, and UPDATE/DELETE replication fails.
    const ok =
      (r.relreplident === "d" && r.has_pk) || r.relreplident === "f" || r.relreplident === "i";
    if (ok) {
      log.ok(`${qt} has replica identity (${r.relreplident === "d" ? "PK" : r.relreplident})`);
    } else {
      log.err(
        `${qt} has no replica identity — UPDATE/DELETE will fail. Set REPLICA IDENTITY FULL.`,
      );
      hardFail = true;
    }
  }

  // 5. Name collisions on source (stale slot/publication from a previous run).
  const [existingSlot] = await source`
    SELECT 1 FROM pg_replication_slots WHERE slot_name = ${cfg.replication.slot}`;
  if (existingSlot)
    log.warn(`slot ${cfg.replication.slot} already exists on source — teardown a prior run first`);
  const [existingPub] = await source`
    SELECT 1 FROM pg_publication WHERE pubname = ${cfg.replication.publication}`;
  if (existingPub) log.warn(`publication ${cfg.replication.publication} already exists on source`);

  if (hardFail) throw new Error("preflight failed — resolve the ✗ items above before continuing");
  log.ok("preflight passed");
}
