import { log } from "../log.ts";

/**
 * Run the live integration tier: a throwaway Postgres pair (source
 * `wal_level=logical`) + a bun runner, all on one Docker Compose network, then
 * tear it down. Returns the runner's exit code (= the test exit code).
 *
 * This orchestrates `docker compose` the same way `cli-wrappers.ts` orchestrates
 * the `supabase` CLI and `bootstrap.ts` orchestrates `pg_dump`/`psql` — the tool
 * shells out to the authoritative external program rather than reimplementing
 * it. A runner SERVICE (not two bare `docker run`s) is required so the
 * subscription's CONNECTION uses the service-DNS name `source:5432`, which
 * resolves identically from the runner and from the target's walreceiver.
 */
const COMPOSE = ["docker", "compose", "-f", "docker-compose.test.yml"];

async function spawn(cmd: string[], quiet = false): Promise<number> {
  const proc = Bun.spawn(cmd, {
    stdout: quiet ? "ignore" : "inherit",
    stderr: quiet ? "ignore" : "inherit",
  });
  return proc.exited;
}

async function dockerComposeAvailable(): Promise<boolean> {
  try {
    return (await spawn(["docker", "compose", "version"], true)) === 0;
  } catch {
    return false;
  }
}

export async function integration(): Promise<number> {
  if (!(await dockerComposeAvailable())) {
    log.err("'docker compose' is not available.");
    log.detail("On Docker Desktop + WSL, enable WSL integration for this distro");
    log.detail("(Settings -> Resources -> WSL Integration), then re-run.");
    return 127;
  }

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await spawn([...COMPOSE, "down", "-v", "--remove-orphans"], true);
  };
  // Tear the network down on Ctrl-C / kill too (the equivalent of bash `trap`).
  // .finally so the process still exits even if `docker compose down` rejects.
  const onSignal = () => {
    void cleanup().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  log.step("integration tier: throwaway Postgres pair (source wal_level=logical) + bun runner");
  try {
    return await spawn([
      ...COMPOSE,
      "up",
      "--abort-on-container-exit",
      "--exit-code-from",
      "runner",
      "runner",
    ]);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await cleanup();
  }
}
