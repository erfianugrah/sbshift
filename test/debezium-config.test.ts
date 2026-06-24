import { describe, expect, test } from "bun:test";
import {
  assertNoConfigExpression,
  type DebeziumPlan,
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

  test("rejects a non-mysql source (SQL Server not spiked yet)", () => {
    // @ts-expect-error — exercising the runtime guard with an unsupported flavour
    const bad = plan({ source: { ...plan().source, flavour: "sqlserver" } });
    expect(() => renderDebeziumServerConfig(bad)).toThrow(/only mysql/);
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

describe("assertNoConfigExpression", () => {
  test("throws on a dollar-brace expression, passes otherwise", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: feeding a literal ${ to the guard
    expect(() => assertNoConfigExpression("a=1\nb=${oops}")).toThrow(/NPE/);
    expect(() => assertNoConfigExpression("a=1\nb=$1\nc=plain")).not.toThrow();
  });
});
