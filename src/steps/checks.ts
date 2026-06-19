/**
 * Shared SQL helpers used by both preflight.ts and doctor.ts.
 * Centralising here ensures C-1 (pg_has_role PG15 crash) is fixed once and
 * stays fixed — both callers import the same version-gated query builder.
 */

/**
 * Version-gated SQL for the CREATE SUBSCRIPTION privilege check.
 *
 * `pg_create_subscription` is a PG16+ role; calling
 * `pg_has_role(current_user, 'pg_create_subscription', 'MEMBER')` on PG15
 * throws "role does not exist" before any version-guard branch is reached.
 * On PG15 we return `false` for has_grant and let the caller fall through to
 * the superuser check.
 */
export function subscribeGrantSQL(pgNum: number): string {
  return pgNum >= 160_000
    ? `SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super,
              pg_has_role(current_user, 'pg_create_subscription', 'MEMBER') AS has_grant`
    : `SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super,
              false AS has_grant`;
}
