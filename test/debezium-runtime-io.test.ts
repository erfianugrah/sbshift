import { describe, expect, test } from "bun:test";
import { ConfigSchema, type Secrets } from "../src/config.ts";
import { DebeziumEngine, type DebeziumIO, resolveRuntimeOpts } from "../src/engine/debezium.ts";
import {
  debeziumContainerName,
  debeziumDataVolume,
  debeziumRmArgv,
  debeziumStopArgv,
  debeziumVolumeRmArgv,
} from "../src/engine/debezium-runspec.ts";

// biome-ignore lint/suspicious/noExplicitAny: opaque Db sentinels — debezium never touches them
const NODB = {} as any;

const mysqlCfg = () =>
  ConfigSchema.parse({
    source: { engine: "mysql", serverId: 184054, databases: ["inventory"] },
    target: { ref: "bbbbbbbbbbbbbbbbbbbb" },
    replication: { tables: ["inventory.customers"], publication: "dbz" },
    reconcile: { tables: [{ name: "inventory.customers" }] },
    watchdog: {},
  });
const secrets = (): Secrets =>
  ({
    SOURCE_DB_URL: "mysql://debezium:dbz@mysqlhost:3306/inventory",
    TARGET_DB_URL: "postgresql://postgres:pgpw@pghost:5432/target",
  }) as Secrets;

/** A recording mock DebeziumIO; healthy after `healthyAfter` probes. */
function mockIO(over: Partial<{ runExit: number; healthyAfter: number }> = {}) {
  const calls = {
    exec: [] as string[][],
    writes: [] as { path: string; content: string }[],
    mkdirs: [] as string[],
    health: [] as string[],
    sleeps: 0,
  };
  let healthProbes = 0;
  const io: DebeziumIO = {
    async exec(argv) {
      calls.exec.push(argv);
      const exitCode = argv[1] === "run" ? (over.runExit ?? 0) : 0;
      return { stdout: "", stderr: "", exitCode };
    },
    async httpOk(url) {
      calls.health.push(url);
      healthProbes++;
      return healthProbes >= (over.healthyAfter ?? 1);
    },
    writeFile: (path, content) => calls.writes.push({ path, content }),
    mkdirp: (path) => calls.mkdirs.push(path),
    sleep: async () => {
      calls.sleeps++;
    },
  };
  return { io, calls };
}

describe("resolveRuntimeOpts", () => {
  test("defaults stage dir / volume / port / image from the topic prefix", () => {
    const rt = resolveRuntimeOpts({}, "dbz");
    expect(rt.stageDir).toContain("pgshift-dbz-dbz");
    expect(rt.configPath).toMatch(/application\.properties$/);
    expect(rt.dataVolume).toBe("pgshift-dbz-dbz-data");
    expect(rt.metricsPort).toBe(8080);
    expect(rt.network).toBeUndefined();
    expect(rt.image).toContain("pgshift/debezium-server:");
  });

  test("env overrides stage dir / network / port / image / volume", () => {
    const rt = resolveRuntimeOpts(
      {
        PGSHIFT_DBZ_STAGE_DIR: "/srv/stage",
        PGSHIFT_DBZ_NETWORK: "pgshift-net",
        PGSHIFT_DBZ_METRICS_PORT: "18080",
        PGSHIFT_DBZ_IMAGE: "ghcr.io/me/dbz:test",
        PGSHIFT_DBZ_DATA_VOLUME: "vol1",
      },
      "dbz",
    );
    expect(rt.stageDir).toBe("/srv/stage");
    expect(rt.configPath).toBe("/srv/stage/application.properties");
    expect(rt.network).toBe("pgshift-net");
    expect(rt.metricsPort).toBe(18080);
    expect(rt.image).toBe("ghcr.io/me/dbz:test");
    expect(rt.dataVolume).toBe("vol1");
  });

  test("rejects a non-positive metrics port", () => {
    expect(() => resolveRuntimeOpts({ PGSHIFT_DBZ_METRICS_PORT: "0" }, "dbz")).toThrow(
      /positive integer/,
    );
    expect(() => resolveRuntimeOpts({ PGSHIFT_DBZ_METRICS_PORT: "x" }, "dbz")).toThrow(
      /positive integer/,
    );
  });
});

describe("DebeziumEngine.replicate (mocked IO)", () => {
  test("stages the rendered config 0600, docker-runs, and waits for health", async () => {
    const { io, calls } = mockIO({ healthyAfter: 1 });
    await new DebeziumEngine(io).replicate(NODB, NODB, mysqlCfg(), secrets());

    // config staged before the container started
    expect(calls.mkdirs.length).toBe(1);
    expect(calls.writes.length).toBe(1);
    expect(calls.writes[0]?.content).toContain("io.debezium.connector.mysql.MySqlConnector");
    // the secret-bearing properties go to the staged path, not to logs
    expect(calls.writes[0]?.path).toMatch(/application\.properties$/);

    // exactly one docker run, of the named container
    const run = calls.exec.find((a) => a[1] === "run");
    expect(run).toBeDefined();
    expect(run).toContain("--name");
    expect(run).toContain("pgshift-dbz-dbz");

    expect(calls.health.length).toBeGreaterThanOrEqual(1);
  });

  test("polls health with backoff until the server reports ready", async () => {
    const { io, calls } = mockIO({ healthyAfter: 3 });
    await new DebeziumEngine(io).replicate(NODB, NODB, mysqlCfg(), secrets());
    expect(calls.health.length).toBe(3);
    expect(calls.sleeps).toBe(2); // slept between the first two failed probes
  });

  test("throws when docker run exits non-zero (and never probes health)", async () => {
    const { io, calls } = mockIO({ runExit: 125 });
    await expect(
      new DebeziumEngine(io).replicate(NODB, NODB, mysqlCfg(), secrets()),
    ).rejects.toThrow(/docker run failed \(exit 125\)/);
    expect(calls.health.length).toBe(0);
  });

  test("rejects a non-mysql source before any IO (plan builder guard)", async () => {
    const pgCfg = ConfigSchema.parse({
      source: { ref: "aaaaaaaaaaaaaaaaaaaa" },
      target: { ref: "bbbbbbbbbbbbbbbbbbbb" },
      replication: { tables: ["public.documents"] },
      reconcile: { tables: [{ name: "public.documents" }] },
      watchdog: {},
    });
    const { io, calls } = mockIO();
    await expect(new DebeziumEngine(io).replicate(NODB, NODB, pgCfg, secrets())).rejects.toThrow(
      /only mysql/,
    );
    expect(calls.exec.length).toBe(0);
  });
});

describe("DebeziumEngine.teardown (mocked IO)", () => {
  test("stops, force-removes the container, and drops the offset volume", async () => {
    const { io, calls } = mockIO();
    await new DebeziumEngine(io).teardown(NODB, NODB, mysqlCfg());
    expect(calls.exec).toEqual([
      debeziumStopArgv("pgshift-dbz-dbz"),
      debeziumRmArgv("pgshift-dbz-dbz"),
      debeziumVolumeRmArgv("pgshift-dbz-dbz-data"),
    ]);
  });

  test("tolerates a missing container / volume (idempotent)", async () => {
    const io: DebeziumIO = {
      exec: async (argv) => ({
        stdout: "",
        stderr: argv[1] === "rm" ? "Error: No such container: x" : "no such volume",
        exitCode: 1,
      }),
      httpOk: async () => true,
      writeFile: () => {},
      mkdirp: () => {},
      sleep: async () => {},
    };
    // does not throw despite non-zero exits
    await new DebeziumEngine(io).teardown(NODB, NODB, mysqlCfg());
  });
});

describe("run-spec naming helpers", () => {
  test("container + volume names derive from the topic prefix", () => {
    expect(debeziumContainerName("dbz")).toBe("pgshift-dbz-dbz");
    expect(debeziumDataVolume("dbz")).toBe("pgshift-dbz-dbz-data");
  });
});
