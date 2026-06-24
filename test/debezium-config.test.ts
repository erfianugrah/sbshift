import { describe, expect, test } from "bun:test";
import { ConfigSchema, type Secrets } from "../src/config.ts";
import {
  assertNoConfigExpression,
  type DebeziumPlan,
  debeziumPlanFromConfig,
  renderDebeziumServerConfig,
} from "../src/engine/debezium-config.ts";

const plan = (over: Partial<DebeziumPlan> = {}): DebeziumPlan => ({
  topicPrefix: "dbz",
  source: {
    flavour: "mysql",
    hostname: "mysql",
    port: 3306,
    user: "debezium",
    password: "dbz",
    serverId: 184054,
    databases: ["inventory"],
    tables: ["inventory.customers"],
  },
  target: {
    jdbcUrl: "jdbc:postgresql://postgres:5432/target",
    user: "postgres",
    password: "postgres",
  },
  schemaEvolution: "none",
  dataDir: "/debezium/data",
  ...over,
});

describe("renderDebeziumServerConfig", () => {
  test("renders the proven no-Kafka MySQL→JDBC-sink topology", () => {
    const c = renderDebeziumServerConfig(plan());
    expect(c).toContain(
      "debezium.source.connector.class=io.debezium.connector.mysql.MySqlConnector",
    );
    expect(c).toContain("debezium.sink.type=jdbc");
    expect(c).toContain("debezium.sink.jdbc.connection.url=jdbc:postgresql://postgres:5432/target");
    expect(c).toContain("debezium.source.database.server.id=184054");
    expect(c).toContain("debezium.source.table.include.list=inventory.customers");
    expect(c).toContain("debezium.source.database.include.list=inventory");
  });

  test("FINDING #5: never emits a dollar-brace expression (would NPE Debezium Server)", () => {
    const c = renderDebeziumServerConfig(plan());
    expect(c).not.toContain("${");
    // topic→table naming uses a RegexRouter with a brace-free $1 replacement instead
    expect(c).toContain(
      "debezium.transforms.route.type=org.apache.kafka.connect.transforms.RegexRouter",
    );
    expect(c).toContain("debezium.transforms.route.replacement=$1");
  });

  test("FINDING #6: production plan pins schema.evolution=none (pre-create from guided draft)", () => {
    expect(renderDebeziumServerConfig(plan())).toContain(
      "debezium.sink.jdbc.schema.evolution=none",
    );
    expect(renderDebeziumServerConfig(plan({ schemaEvolution: "basic" }))).toContain(
      "debezium.sink.jdbc.schema.evolution=basic",
    );
  });

  test("FINDING #7: no ExtractNewRecordState SMT (JDBC sink ingests native events)", () => {
    expect(renderDebeziumServerConfig(plan())).not.toContain("ExtractNewRecordState");
  });

  test("route regex escapes the prefix dots and keeps only the final topic segment", () => {
    const c = renderDebeziumServerConfig(plan({ topicPrefix: "dbz" }));
    expect(c).toContain("debezium.transforms.route.regex=dbz\\.[^.]+\\.(.*)");
  });

  test("joins multiple tables and databases comma-separated", () => {
    const c = renderDebeziumServerConfig(
      plan({
        source: {
          ...plan().source,
          databases: ["inventory", "sales"],
          tables: ["inventory.customers", "sales.orders"],
        },
      }),
    );
    expect(c).toContain("debezium.source.database.include.list=inventory,sales");
    expect(c).toContain("debezium.source.table.include.list=inventory.customers,sales.orders");
  });

  test("renders the SQL Server CDC connector topology", () => {
    const c = renderDebeziumServerConfig(
      plan({
        source: {
          flavour: "sqlserver",
          hostname: "mssql",
          port: 1433,
          user: "sa",
          password: "pw",
          databases: ["inventory"],
          tables: ["dbo.customers"],
          encrypt: false,
        },
      }),
    );
    expect(c).toContain(
      "debezium.source.connector.class=io.debezium.connector.sqlserver.SqlServerConnector",
    );
    expect(c).toContain("debezium.source.database.names=inventory");
    expect(c).not.toContain("database.include.list"); // SQL Server uses database.names
    expect(c).toContain("debezium.source.database.encrypt=false");
    expect(c).toContain("debezium.source.table.include.list=dbo.customers");
    expect(c).toContain("debezium.sink.type=jdbc");
    // 4-segment topic (<prefix>.<db>.<schema>.<table>) needs one extra stripped segment
    expect(c).toContain("debezium.transforms.route.regex=dbz\\.[^.]+\\.[^.]+\\.(.*)");
    expect(c).not.toContain("${");
  });

  test("SQL Server encrypt=true flows through (Azure SQL requires TLS)", () => {
    const c = renderDebeziumServerConfig(
      plan({
        source: {
          flavour: "sqlserver",
          hostname: "azure",
          port: 1433,
          user: "sa",
          password: "pw",
          databases: ["db"],
          tables: ["dbo.t"],
          encrypt: true,
        },
      }),
    );
    expect(c).toContain("debezium.source.database.encrypt=true");
  });

  test("rejects an empty table or database set", () => {
    expect(() =>
      renderDebeziumServerConfig(plan({ source: { ...plan().source, tables: [] } })),
    ).toThrow(/no source tables/);
    expect(() =>
      renderDebeziumServerConfig(plan({ source: { ...plan().source, databases: [] } })),
    ).toThrow(/no source databases/);
  });
});

describe("debeziumPlanFromConfig", () => {
  const mysqlCfg = (over: Record<string, unknown> = {}) =>
    ConfigSchema.parse({
      source: { engine: "mysql", serverId: 184054, databases: ["inventory"] },
      target: { ref: "bbbbbbbbbbbbbbbbbbbb" },
      replication: { tables: ["inventory.customers", "inventory.orders"], publication: "dbz" },
      reconcile: { tables: [{ name: "inventory.customers" }] },
      watchdog: {},
      ...over,
    });
  const secrets = (over: Partial<Secrets> = {}): Secrets =>
    ({
      SOURCE_DB_URL: "mysql://debezium:dbz@mysqlhost:3306/inventory",
      TARGET_DB_URL: "postgresql://postgres:pgpw@pghost:5432/target",
      ...over,
    }) as Secrets;

  test("maps config + secrets into a renderable plan", () => {
    const p = debeziumPlanFromConfig(mysqlCfg(), secrets());
    expect(p.topicPrefix).toBe("dbz"); // from replication.publication
    expect(p.source).toMatchObject({
      flavour: "mysql",
      hostname: "mysqlhost",
      port: 3306,
      user: "debezium",
      password: "dbz",
      serverId: 184054,
      databases: ["inventory"],
      tables: ["inventory.customers", "inventory.orders"], // from replication.tables
    });
    expect(p.target).toEqual({
      jdbcUrl: "jdbc:postgresql://pghost:5432/target",
      user: "postgres",
      password: "pgpw",
    });
    expect(p.schemaEvolution).toBe("none"); // production default (finding #6)
    expect(p.dataDir).toBe("/debezium/data");
  });

  test("the built plan round-trips through the renderer", () => {
    const c = renderDebeziumServerConfig(debeziumPlanFromConfig(mysqlCfg(), secrets()));
    expect(c).toContain("debezium.source.database.hostname=mysqlhost");
    expect(c).toContain("debezium.source.database.server.id=184054");
    expect(c).toContain("debezium.sink.jdbc.connection.url=jdbc:postgresql://pghost:5432/target");
    expect(c).toContain("debezium.source.table.include.list=inventory.customers,inventory.orders");
  });

  test("defaults missing ports and percent-decodes credentials", () => {
    const p = debeziumPlanFromConfig(
      mysqlCfg(),
      secrets({
        SOURCE_DB_URL: "mysql://deb%40zium:p%40ss@mysqlhost/inventory", // no port, encoded creds
      }),
    );
    expect(p.source.port).toBe(3306); // mysql default
    expect(p.source.user).toBe("deb@zium");
    expect(p.source.password).toBe("p@ss");
  });

  test("honours a schemaEvolution=basic override (spike/smoke only)", () => {
    const p = debeziumPlanFromConfig(mysqlCfg(), secrets(), { schemaEvolution: "basic" });
    expect(p.schemaEvolution).toBe("basic");
  });

  test("rejects a postgres source (native logical replication, no Debezium)", () => {
    const pgCfg = ConfigSchema.parse({
      source: { ref: "aaaaaaaaaaaaaaaaaaaa" },
      target: { ref: "bbbbbbbbbbbbbbbbbbbb" },
      replication: { tables: ["public.documents"] },
      reconcile: { tables: [{ name: "public.documents" }] },
      watchdog: {},
    });
    expect(() => debeziumPlanFromConfig(pgCfg, secrets())).toThrow(/only heterogeneous/);
  });

  test("maps a SQL Server config + secrets into a renderable plan (encrypt from URL)", () => {
    const ssCfg = ConfigSchema.parse({
      source: { engine: "sqlserver", databases: ["inventory"] },
      target: { ref: "bbbbbbbbbbbbbbbbbbbb" },
      replication: { tables: ["dbo.customers"], publication: "dbz" },
      reconcile: { tables: [{ name: "dbo.customers" }] },
      watchdog: {},
    });
    const p = debeziumPlanFromConfig(
      ssCfg,
      secrets({ SOURCE_DB_URL: "sqlserver://sa:pw@mssqlhost:1433/inventory?encrypt=true" }),
    );
    expect(p.source).toMatchObject({
      flavour: "sqlserver",
      hostname: "mssqlhost",
      port: 1433,
      user: "sa",
      databases: ["inventory"],
      tables: ["dbo.customers"],
      encrypt: true,
    });
    const c = renderDebeziumServerConfig(p);
    expect(c).toContain("debezium.source.database.names=inventory");
    expect(c).toContain("debezium.source.database.encrypt=true");
  });

  test("SQL Server source defaults port 1433 and encrypt=false", () => {
    const ssCfg = ConfigSchema.parse({
      source: { engine: "sqlserver", databases: ["inventory"] },
      target: { ref: "bbbbbbbbbbbbbbbbbbbb" },
      replication: { tables: ["dbo.customers"], publication: "dbz" },
      reconcile: { tables: [{ name: "dbo.customers" }] },
      watchdog: {},
    });
    const p = debeziumPlanFromConfig(
      ssCfg,
      secrets({ SOURCE_DB_URL: "sqlserver://sa:pw@mssqlhost/inventory" }),
    );
    expect(p.source.port).toBe(1433);
    expect((p.source as { encrypt: boolean }).encrypt).toBe(false);
  });
});

describe("assertNoConfigExpression", () => {
  test("throws on a dollar-brace expression, passes otherwise", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: feeding a literal ${ to the guard
    expect(() => assertNoConfigExpression("a=1\nb=${oops}")).toThrow(/NPE/);
    expect(() => assertNoConfigExpression("a=1\nb=$1\nc=plain")).not.toThrow();
  });
});
