import { describe, expect, test } from "bun:test";
import {
  type AggColumn,
  aggAlias,
  aggregatesFor,
  categorizePgType,
  diffAggregates,
  parseAggregateRow,
  reconcileAggregateReport,
  renderAggregateQuery,
  type TableAggregates,
} from "../src/engine/reconcile-aggregate.ts";

describe("aggregatesFor", () => {
  test("numeric gets full signal, text gets non_null + char length, others non_null only", () => {
    expect(aggregatesFor("numeric")).toEqual(["non_null", "sum", "min", "max"]);
    expect(aggregatesFor("text")).toEqual(["non_null", "char_len_sum"]);
    expect(aggregatesFor("temporal")).toEqual(["non_null"]);
    expect(aggregatesFor("boolean")).toEqual(["non_null"]);
    expect(aggregatesFor("other")).toEqual(["non_null"]);
  });
});

describe("categorizePgType", () => {
  test("maps Postgres data_type strings to categories", () => {
    expect(categorizePgType("integer")).toBe("numeric");
    expect(categorizePgType("bigint")).toBe("numeric");
    expect(categorizePgType("numeric")).toBe("numeric");
    expect(categorizePgType("double precision")).toBe("numeric");
    expect(categorizePgType("character varying")).toBe("text");
    expect(categorizePgType("text")).toBe("text");
    expect(categorizePgType("uuid")).toBe("text");
    expect(categorizePgType("timestamp without time zone")).toBe("temporal");
    expect(categorizePgType("date")).toBe("temporal");
    expect(categorizePgType("boolean")).toBe("boolean");
    expect(categorizePgType("jsonb")).toBe("other");
  });
});

describe("renderAggregateQuery", () => {
  const cols: AggColumn[] = [
    { name: "id", category: "numeric" },
    { name: "name", category: "text" },
    { name: "created_at", category: "temporal" },
  ];

  test("MySQL: backtick quoting, CHAR_LENGTH, deterministic aliases", () => {
    const q = renderAggregateQuery("mysql", "inventory", "customers", cols);
    expect(q).toContain("count(*) AS `rowcount`");
    expect(q).toContain("FROM `inventory`.`customers`");
    expect(q).toContain("sum(`id`) AS c0_sum");
    expect(q).toContain("min(`id`) AS c0_min");
    expect(q).toContain("max(`id`) AS c0_max");
    expect(q).toContain("count(`id`) AS c0_non_null");
    expect(q).toContain("sum(CHAR_LENGTH(`name`)) AS c1_char_len_sum");
    expect(q).toContain("count(`created_at`) AS c2_non_null");
    // temporal gets non_null only — no min/max
    expect(q).not.toContain("c2_min");
  });

  test("SQL Server: bracket quoting, LEN, deterministic aliases", () => {
    const q = renderAggregateQuery("sqlserver", "dbo", "customers", cols);
    // `rowcount` is a T-SQL reserved keyword — the alias MUST be bracket-quoted or it is a syntax error
    expect(q).toContain("count(*) AS [rowcount]");
    expect(q).not.toContain("AS rowcount");
    expect(q).toContain("FROM [dbo].[customers]");
    expect(q).toContain("sum([id]) AS c0_sum");
    expect(q).toContain("count([id]) AS c0_non_null");
    expect(q).toContain("sum(LEN([name])) AS c1_char_len_sum");
    expect(q).toContain("count([created_at]) AS c2_non_null");
    expect(q).not.toContain("c2_min");
  });

  test("Postgres: double-quote quoting, char_length", () => {
    const q = renderAggregateQuery("postgres", "public", "customers", cols);
    expect(q).toContain('count(*) AS "rowcount"');
    expect(q).toContain('FROM "public"."customers"');
    expect(q).toContain('sum(char_length("name")) AS c1_char_len_sum');
    expect(q).toContain('sum("id") AS c0_sum');
  });

  test("the two dialects render identical aliases for the same column set (so rows line up)", () => {
    const my = renderAggregateQuery("mysql", "inventory", "customers", cols);
    const pg = renderAggregateQuery("postgres", "public", "customers", cols);
    for (const alias of [
      "c0_sum",
      "c0_min",
      "c0_max",
      "c0_non_null",
      "c1_char_len_sum",
      "c2_non_null",
    ]) {
      expect(my).toContain(`AS ${alias}`);
      expect(pg).toContain(`AS ${alias}`);
    }
  });
});

describe("aggAlias", () => {
  test("is stable and unique per (column index, metric)", () => {
    expect(aggAlias(0, "sum")).toBe("c0_sum");
    expect(aggAlias(3, "char_len_sum")).toBe("c3_char_len_sum");
  });
});

describe("parseAggregateRow", () => {
  const cols: AggColumn[] = [
    { name: "id", category: "numeric" },
    { name: "name", category: "text" },
  ];

  test("normalizes bigint/number/null scalars to string|null keyed by metric", () => {
    const agg = parseAggregateRow(
      {
        rowcount: 4n,
        c0_non_null: 4,
        c0_sum: 100n,
        c0_min: 1,
        c0_max: 40,
        c1_non_null: 3,
        c1_char_len_sum: 27n,
      },
      cols,
    );
    expect(agg.rowCount).toBe("4");
    expect(agg.columns[0]).toEqual({
      column: "id",
      metrics: { non_null: "4", sum: "100", min: "1", max: "40" },
    });
    expect(agg.columns[1]).toEqual({
      column: "name",
      metrics: { non_null: "3", char_len_sum: "27" },
    });
  });

  test("missing/null aggregate values become null (e.g. all-null column → sum null)", () => {
    const agg = parseAggregateRow(
      { rowcount: 0n, c0_non_null: 0, c0_sum: null, c0_min: null, c0_max: null },
      [{ name: "id", category: "numeric" }],
    );
    expect(agg.columns[0]?.metrics).toEqual({ non_null: "0", sum: null, min: null, max: null });
  });
});

describe("diffAggregates", () => {
  const mk = (over: Partial<TableAggregates> = {}): TableAggregates => ({
    rowCount: "4",
    columns: [
      { column: "id", metrics: { non_null: "4", sum: "100", min: "1", max: "40" } },
      { column: "name", metrics: { non_null: "4", char_len_sum: "27" } },
    ],
    ...over,
  });

  test("identical aggregates produce no mismatch", () => {
    expect(diffAggregates(mk(), mk())).toEqual([]);
  });

  test("row-count drift is flagged", () => {
    const d = diffAggregates(mk(), mk({ rowCount: "5" }));
    expect(d).toContainEqual({ kind: "row_count", source: "4", target: "5" });
  });

  test("a divergent column metric is flagged with both values", () => {
    const target = mk({
      columns: [
        { column: "id", metrics: { non_null: "4", sum: "101", min: "1", max: "40" } },
        { column: "name", metrics: { non_null: "4", char_len_sum: "27" } },
      ],
    });
    const d = diffAggregates(mk(), target);
    expect(d).toEqual([
      { kind: "column_metric", column: "id", metric: "sum", source: "100", target: "101" },
    ]);
  });

  test("a column present on only one side is flagged as missing on the other", () => {
    const target = mk({
      columns: [{ column: "id", metrics: { non_null: "4", sum: "100", min: "1", max: "40" } }],
    });
    const d = diffAggregates(mk(), target);
    expect(d).toContainEqual({ kind: "column_missing", column: "name", side: "target" });
  });

  test("null-vs-value on a metric counts as a mismatch", () => {
    const source = mk({
      columns: [{ column: "id", metrics: { non_null: "4", sum: null, min: "1", max: "40" } }],
    });
    const target = mk({
      columns: [{ column: "id", metrics: { non_null: "4", sum: "100", min: "1", max: "40" } }],
    });
    const d = diffAggregates(source, target);
    expect(d).toContainEqual({
      kind: "column_metric",
      column: "id",
      metric: "sum",
      source: null,
      target: "100",
    });
  });
});

describe("reconcileAggregateReport", () => {
  const same: TableAggregates = {
    rowCount: "4",
    columns: [{ column: "id", metrics: { non_null: "4", sum: "100", min: "1", max: "40" } }],
  };

  test("passes when identical and always carries the downgrade caveat", () => {
    const r = reconcileAggregateReport("inventory.customers", same, same);
    expect(r.match).toBe(true);
    expect(r.mismatches).toEqual([]);
    expect(r.sourceRows).toBe("4");
    expect(r.caveat).toMatch(/NOT a byte-exact row hash/);
  });

  test("fails when aggregates diverge", () => {
    const drifted: TableAggregates = { ...same, rowCount: "5" };
    const r = reconcileAggregateReport("inventory.customers", same, drifted);
    expect(r.match).toBe(false);
    expect(r.mismatches.length).toBeGreaterThan(0);
  });
});
