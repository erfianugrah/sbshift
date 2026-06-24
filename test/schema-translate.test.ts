import { describe, expect, test } from "bun:test";
import {
  type MySqlColumn,
  renderCreateTable,
  translateColumn,
} from "../src/engine/schema-translate.ts";

const col = (
  over: Partial<MySqlColumn> & { COLUMN_NAME: string; DATA_TYPE: string },
): MySqlColumn => ({
  COLUMN_TYPE: over.DATA_TYPE,
  IS_NULLABLE: "YES",
  COLUMN_KEY: "",
  EXTRA: "",
  CHARACTER_MAXIMUM_LENGTH: null,
  NUMERIC_PRECISION: null,
  NUMERIC_SCALE: null,
  ...over,
});

describe("translateColumn — type matrix", () => {
  test("TINYINT(1) → boolean, flagged for review", () => {
    const t = translateColumn(
      col({ COLUMN_NAME: "active", DATA_TYPE: "tinyint", COLUMN_TYPE: "tinyint(1)" }),
    );
    expect(t.pgType).toBe("boolean");
    expect(t.review).toMatch(/smallint/);
  });

  test("TINYINT(n>1) → smallint, no review", () => {
    const t = translateColumn(
      col({ COLUMN_NAME: "age", DATA_TYPE: "tinyint", COLUMN_TYPE: "tinyint(4)" }),
    );
    expect(t.pgType).toBe("smallint");
    expect(t.review).toBeUndefined();
  });

  test("unsigned ints widen: INT UNSIGNED → bigint, BIGINT UNSIGNED → numeric", () => {
    expect(
      translateColumn(col({ COLUMN_NAME: "a", DATA_TYPE: "int", COLUMN_TYPE: "int unsigned" }))
        .pgType,
    ).toBe("bigint");
    const big = translateColumn(
      col({ COLUMN_NAME: "b", DATA_TYPE: "bigint", COLUMN_TYPE: "bigint unsigned" }),
    );
    expect(big.pgType).toBe("numeric");
    expect(big.review).toMatch(/exceeds bigint/);
  });

  test("signed ints map straight through", () => {
    expect(
      translateColumn(col({ COLUMN_NAME: "i", DATA_TYPE: "int", COLUMN_TYPE: "int" })).pgType,
    ).toBe("integer");
    expect(
      translateColumn(col({ COLUMN_NAME: "b", DATA_TYPE: "bigint", COLUMN_TYPE: "bigint" })).pgType,
    ).toBe("bigint");
    expect(
      translateColumn(col({ COLUMN_NAME: "m", DATA_TYPE: "mediumint", COLUMN_TYPE: "mediumint" }))
        .pgType,
    ).toBe("integer");
  });

  test("decimal preserves precision/scale", () => {
    const t = translateColumn(
      col({
        COLUMN_NAME: "price",
        DATA_TYPE: "decimal",
        COLUMN_TYPE: "decimal(10,2)",
        NUMERIC_PRECISION: 10,
        NUMERIC_SCALE: 2,
      }),
    );
    expect(t.pgType).toBe("numeric(10,2)");
  });

  test("char/varchar preserve length; text-family → text", () => {
    expect(
      translateColumn(
        col({
          COLUMN_NAME: "c",
          DATA_TYPE: "varchar",
          COLUMN_TYPE: "varchar(255)",
          CHARACTER_MAXIMUM_LENGTH: 255,
        }),
      ).pgType,
    ).toBe("varchar(255)");
    expect(
      translateColumn(
        col({
          COLUMN_NAME: "c",
          DATA_TYPE: "char",
          COLUMN_TYPE: "char(3)",
          CHARACTER_MAXIMUM_LENGTH: 3,
        }),
      ).pgType,
    ).toBe("char(3)");
    expect(
      translateColumn(col({ COLUMN_NAME: "c", DATA_TYPE: "longtext", COLUMN_TYPE: "longtext" }))
        .pgType,
    ).toBe("text");
  });

  test("datetime → timestamptz with a tz review; timestamp → timestamptz clean", () => {
    const dt = translateColumn(
      col({ COLUMN_NAME: "ca", DATA_TYPE: "datetime", COLUMN_TYPE: "datetime" }),
    );
    expect(dt.pgType).toBe("timestamptz");
    expect(dt.review).toMatch(/tz/i);
    expect(
      translateColumn(col({ COLUMN_NAME: "ts", DATA_TYPE: "timestamp", COLUMN_TYPE: "timestamp" }))
        .review,
    ).toBeUndefined();
  });

  test("enum/set → text with review; json → jsonb; blob → bytea", () => {
    expect(
      translateColumn(col({ COLUMN_NAME: "e", DATA_TYPE: "enum", COLUMN_TYPE: "enum('a','b')" }))
        .review,
    ).toMatch(/ENUM/);
    expect(
      translateColumn(col({ COLUMN_NAME: "s", DATA_TYPE: "set", COLUMN_TYPE: "set('x','y')" }))
        .review,
    ).toMatch(/SET/);
    expect(
      translateColumn(col({ COLUMN_NAME: "j", DATA_TYPE: "json", COLUMN_TYPE: "json" })).pgType,
    ).toBe("jsonb");
    expect(
      translateColumn(col({ COLUMN_NAME: "b", DATA_TYPE: "blob", COLUMN_TYPE: "blob" })).pgType,
    ).toBe("bytea");
  });

  test("unknown type falls back to text and is flagged REVIEW", () => {
    const t = translateColumn(
      col({ COLUMN_NAME: "x", DATA_TYPE: "geomcollection", COLUMN_TYPE: "geomcollection" }),
    );
    expect(t.pgType).toBe("text");
    expect(t.review).toMatch(/REVIEW/);
  });

  test("NOT NULL is carried from IS_NULLABLE", () => {
    expect(
      translateColumn(
        col({ COLUMN_NAME: "id", DATA_TYPE: "int", COLUMN_TYPE: "int", IS_NULLABLE: "NO" }),
      ).nullable,
    ).toBe(false);
  });
});

describe("renderCreateTable", () => {
  // the demo inventory.customers schema (id int PK auto_inc, names varchar, email varchar)
  const customers: MySqlColumn[] = [
    col({
      COLUMN_NAME: "id",
      DATA_TYPE: "int",
      COLUMN_TYPE: "int",
      IS_NULLABLE: "NO",
      COLUMN_KEY: "PRI",
      EXTRA: "auto_increment",
    }),
    col({
      COLUMN_NAME: "first_name",
      DATA_TYPE: "varchar",
      COLUMN_TYPE: "varchar(255)",
      IS_NULLABLE: "NO",
      CHARACTER_MAXIMUM_LENGTH: 255,
    }),
    col({
      COLUMN_NAME: "last_name",
      DATA_TYPE: "varchar",
      COLUMN_TYPE: "varchar(255)",
      IS_NULLABLE: "NO",
      CHARACTER_MAXIMUM_LENGTH: 255,
    }),
    col({
      COLUMN_NAME: "email",
      DATA_TYPE: "varchar",
      COLUMN_TYPE: "varchar(255)",
      IS_NULLABLE: "NO",
      CHARACTER_MAXIMUM_LENGTH: 255,
    }),
  ];

  test("renders idempotent CREATE TABLE in public with NOT NULL + PK", () => {
    const d = renderCreateTable("customers", customers, ["id"]);
    expect(d.sql).toContain('CREATE TABLE IF NOT EXISTS "public"."customers"');
    expect(d.sql).toContain('"id" integer NOT NULL');
    expect(d.sql).toContain('"email" varchar(255) NOT NULL');
    expect(d.sql).toContain('PRIMARY KEY ("id")');
    expect(d.decisions).toEqual([]); // clean schema, nothing to ratify
  });

  test("collects per-column review decisions for guided types", () => {
    const withEnum = [
      ...customers,
      col({ COLUMN_NAME: "status", DATA_TYPE: "enum", COLUMN_TYPE: "enum('a','b')" }),
    ];
    const d = renderCreateTable("customers", withEnum, ["id"]);
    expect(d.decisions).toContainEqual({
      table: "customers",
      column: "status",
      review: expect.stringMatching(/ENUM/),
    });
  });

  test("composite primary key", () => {
    const d = renderCreateTable("xref", customers, ["first_name", "last_name"]);
    expect(d.sql).toContain('PRIMARY KEY ("first_name", "last_name")');
  });
});

import type { MySqlConn } from "../src/engine/mysql.ts";
import { draftTargetSchema } from "../src/engine/schema-translate.ts";

describe("draftTargetSchema (fake information_schema)", () => {
  const conn: MySqlConn = {
    query: async <T>(sql: string): Promise<T[]> => {
      if (sql.includes("KEY_COLUMN_USAGE")) return [{ COLUMN_NAME: "id" }] as T[];
      if (sql.includes("information_schema.COLUMNS")) {
        return [
          {
            COLUMN_NAME: "id",
            DATA_TYPE: "int",
            COLUMN_TYPE: "int",
            IS_NULLABLE: "NO",
            COLUMN_KEY: "PRI",
            EXTRA: "auto_increment",
            CHARACTER_MAXIMUM_LENGTH: null,
            NUMERIC_PRECISION: 10,
            NUMERIC_SCALE: 0,
          },
          {
            COLUMN_NAME: "active",
            DATA_TYPE: "tinyint",
            COLUMN_TYPE: "tinyint(1)",
            IS_NULLABLE: "YES",
            COLUMN_KEY: "",
            EXTRA: "",
            CHARACTER_MAXIMUM_LENGTH: null,
            NUMERIC_PRECISION: 3,
            NUMERIC_SCALE: 0,
          },
        ] as T[];
      }
      return [] as T[];
    },
    end: async () => {},
  };

  test("drafts CREATE TABLE + collects guided decisions from a live-shaped result", async () => {
    const d = await draftTargetSchema(conn, "inventory", ["customers"]);
    expect(d.sql).toContain('CREATE TABLE IF NOT EXISTS "public"."customers"');
    expect(d.sql).toContain('"id" integer NOT NULL');
    expect(d.sql).toContain('"active" boolean');
    expect(d.sql).toContain('PRIMARY KEY ("id")');
    // the TINYINT(1) needs a human decision
    expect(d.decisions).toContainEqual({
      table: "customers",
      column: "active",
      review: expect.stringMatching(/smallint/),
    });
  });

  test("throws when a table has no columns (missing table)", async () => {
    const empty: MySqlConn = { query: async () => [], end: async () => {} };
    await expect(draftTargetSchema(empty, "inventory", ["ghost"])).rejects.toThrow(/no columns/);
  });
});
