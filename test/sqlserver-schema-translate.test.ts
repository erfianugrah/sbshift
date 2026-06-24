import { describe, expect, test } from "bun:test";
import type { SqlServerConn } from "../src/engine/sqlserver.ts";
import {
  draftTargetSchemaSqlServer,
  type SqlServerColumn,
  translateColumn,
} from "../src/engine/sqlserver-schema-translate.ts";

const col = (
  over: Partial<SqlServerColumn> & { COLUMN_NAME: string; DATA_TYPE: string },
): SqlServerColumn => ({
  IS_NULLABLE: "YES",
  CHARACTER_MAXIMUM_LENGTH: null,
  NUMERIC_PRECISION: null,
  NUMERIC_SCALE: null,
  DATETIME_PRECISION: null,
  ...over,
});

describe("translateColumn — SQL Server type matrix", () => {
  test("integer family + tinyint widening", () => {
    expect(translateColumn(col({ COLUMN_NAME: "a", DATA_TYPE: "tinyint" })).pgType).toBe(
      "smallint",
    );
    expect(translateColumn(col({ COLUMN_NAME: "a", DATA_TYPE: "smallint" })).pgType).toBe(
      "smallint",
    );
    expect(translateColumn(col({ COLUMN_NAME: "a", DATA_TYPE: "int" })).pgType).toBe("integer");
    expect(translateColumn(col({ COLUMN_NAME: "a", DATA_TYPE: "bigint" })).pgType).toBe("bigint");
  });

  test("bit → boolean; uniqueidentifier → uuid", () => {
    expect(translateColumn(col({ COLUMN_NAME: "b", DATA_TYPE: "bit" })).pgType).toBe("boolean");
    expect(translateColumn(col({ COLUMN_NAME: "g", DATA_TYPE: "uniqueidentifier" })).pgType).toBe(
      "uuid",
    );
  });

  test("money/smallmoney → fixed numeric; decimal preserves precision", () => {
    expect(translateColumn(col({ COLUMN_NAME: "m", DATA_TYPE: "money" })).pgType).toBe(
      "numeric(19,4)",
    );
    expect(translateColumn(col({ COLUMN_NAME: "m", DATA_TYPE: "smallmoney" })).pgType).toBe(
      "numeric(10,4)",
    );
    expect(
      translateColumn(
        col({ COLUMN_NAME: "d", DATA_TYPE: "decimal", NUMERIC_PRECISION: 10, NUMERIC_SCALE: 2 }),
      ).pgType,
    ).toBe("numeric(10,2)");
  });

  test("float → double precision; real → real", () => {
    expect(translateColumn(col({ COLUMN_NAME: "f", DATA_TYPE: "float" })).pgType).toBe(
      "double precision",
    );
    expect(translateColumn(col({ COLUMN_NAME: "r", DATA_TYPE: "real" })).pgType).toBe("real");
  });

  test("datetime → timestamp with tz review; datetimeoffset → timestamptz", () => {
    const dt = translateColumn(col({ COLUMN_NAME: "c", DATA_TYPE: "datetime" }));
    expect(dt.pgType).toBe("timestamp");
    expect(dt.review).toMatch(/time zone|tz/i);
    expect(
      translateColumn(col({ COLUMN_NAME: "o", DATA_TYPE: "datetimeoffset", DATETIME_PRECISION: 3 }))
        .pgType,
    ).toBe("timestamptz(3)");
  });

  test("datetime2(p) carries precision; p=7 truncates to 6 with a precision-loss review", () => {
    expect(
      translateColumn(col({ COLUMN_NAME: "c", DATA_TYPE: "datetime2", DATETIME_PRECISION: 6 }))
        .pgType,
    ).toBe("timestamp(6)");
    const lossy = translateColumn(
      col({ COLUMN_NAME: "c", DATA_TYPE: "datetime2", DATETIME_PRECISION: 7 }),
    );
    expect(lossy.pgType).toBe("timestamp(6)");
    expect(lossy.review).toMatch(/exceeds Postgres max 6/);
  });

  test("time(7) truncates to time(6) with precision-loss review", () => {
    const t = translateColumn(col({ COLUMN_NAME: "t", DATA_TYPE: "time", DATETIME_PRECISION: 7 }));
    expect(t.pgType).toBe("time(6)");
    expect(t.review).toMatch(/exceeds Postgres max 6/);
  });

  test("char/varchar length; nvarchar(MAX) and varchar(-1) → text", () => {
    expect(
      translateColumn(col({ COLUMN_NAME: "c", DATA_TYPE: "nchar", CHARACTER_MAXIMUM_LENGTH: 3 }))
        .pgType,
    ).toBe("char(3)");
    expect(
      translateColumn(
        col({ COLUMN_NAME: "v", DATA_TYPE: "nvarchar", CHARACTER_MAXIMUM_LENGTH: 255 }),
      ).pgType,
    ).toBe("varchar(255)");
    expect(
      translateColumn(
        col({ COLUMN_NAME: "v", DATA_TYPE: "nvarchar", CHARACTER_MAXIMUM_LENGTH: -1 }),
      ).pgType,
    ).toBe("text");
    expect(translateColumn(col({ COLUMN_NAME: "t", DATA_TYPE: "ntext" })).pgType).toBe("text");
  });

  test("binary/image → bytea", () => {
    expect(translateColumn(col({ COLUMN_NAME: "b", DATA_TYPE: "varbinary" })).pgType).toBe("bytea");
    expect(translateColumn(col({ COLUMN_NAME: "i", DATA_TYPE: "image" })).pgType).toBe("bytea");
  });

  test("ROWVERSION/timestamp is the binary-version trap, NOT a datetime", () => {
    const ts = translateColumn(col({ COLUMN_NAME: "v", DATA_TYPE: "timestamp" }));
    expect(ts.pgType).toBe("bytea");
    expect(ts.review).toMatch(/row-version|ROWVERSION|NOT a datetime/i);
    expect(translateColumn(col({ COLUMN_NAME: "v", DATA_TYPE: "rowversion" })).pgType).toBe(
      "bytea",
    );
  });

  test("spatial / hierarchyid / sql_variant → text with a design-decision review", () => {
    for (const dt of ["geography", "geometry", "hierarchyid", "sql_variant"]) {
      const t = translateColumn(col({ COLUMN_NAME: "x", DATA_TYPE: dt }));
      expect(t.pgType).toBe("text");
      expect(t.review).toBeDefined();
    }
  });

  test("xml → xml with a review; unknown → text REVIEW", () => {
    expect(translateColumn(col({ COLUMN_NAME: "x", DATA_TYPE: "xml" })).pgType).toBe("xml");
    const u = translateColumn(col({ COLUMN_NAME: "u", DATA_TYPE: "newtype" }));
    expect(u.pgType).toBe("text");
    expect(u.review).toMatch(/REVIEW/);
  });

  test("IDENTITY column → base type, flagged (sequence resync at cutover)", () => {
    const t = translateColumn(
      col({ COLUMN_NAME: "id", DATA_TYPE: "int", IS_NULLABLE: "NO", IS_IDENTITY: 1 }),
    );
    expect(t.pgType).toBe("integer");
    expect(t.review).toMatch(/IDENTITY/);
  });

  test("COMPUTED column → base type, flagged with the GENERATED-conversion note", () => {
    const t = translateColumn(col({ COLUMN_NAME: "total", DATA_TYPE: "money", IS_COMPUTED: 1 }));
    expect(t.pgType).toBe("numeric(19,4)");
    expect(t.review).toMatch(/COMPUTED/);
  });

  test("identity overlay preserves a base-type review (datetimeoffset precision loss)", () => {
    const t = translateColumn(
      col({ COLUMN_NAME: "x", DATA_TYPE: "datetimeoffset", DATETIME_PRECISION: 7, IS_IDENTITY: 1 }),
    );
    expect(t.review).toMatch(/exceeds Postgres max 6/);
    expect(t.review).toMatch(/IDENTITY/);
  });

  test("NOT NULL carried from IS_NULLABLE", () => {
    expect(
      translateColumn(col({ COLUMN_NAME: "id", DATA_TYPE: "int", IS_NULLABLE: "NO" })).nullable,
    ).toBe(false);
  });
});

describe("draftTargetSchemaSqlServer (fake catalog)", () => {
  const conn: SqlServerConn = {
    query: async <T>(text: string): Promise<T[]> => {
      if (text.includes("TABLE_CONSTRAINTS")) return [{ COLUMN_NAME: "id" }] as T[];
      if (text.includes("INFORMATION_SCHEMA.COLUMNS")) {
        return [
          {
            COLUMN_NAME: "id",
            DATA_TYPE: "int",
            IS_NULLABLE: "NO",
            CHARACTER_MAXIMUM_LENGTH: null,
            NUMERIC_PRECISION: 10,
            NUMERIC_SCALE: 0,
            DATETIME_PRECISION: null,
            IS_IDENTITY: 1,
            IS_COMPUTED: 0,
          },
          {
            COLUMN_NAME: "uid",
            DATA_TYPE: "uniqueidentifier",
            IS_NULLABLE: "YES",
            CHARACTER_MAXIMUM_LENGTH: null,
            NUMERIC_PRECISION: null,
            NUMERIC_SCALE: null,
            DATETIME_PRECISION: null,
            IS_IDENTITY: 0,
            IS_COMPUTED: 0,
          },
        ] as T[];
      }
      return [] as T[];
    },
    end: async () => {},
  };

  test("drafts CREATE TABLE in public + collects the identity decision", async () => {
    const d = await draftTargetSchemaSqlServer(conn, "dbo", ["customers"]);
    expect(d.sql).toContain('CREATE TABLE IF NOT EXISTS "public"."customers"');
    expect(d.sql).toContain('"id" integer NOT NULL');
    expect(d.sql).toContain('"uid" uuid');
    expect(d.sql).toContain('PRIMARY KEY ("id")');
    expect(d.decisions).toContainEqual({
      table: "customers",
      column: "id",
      review: expect.stringMatching(/IDENTITY/),
    });
  });

  test("throws when a table has no columns (missing table)", async () => {
    const empty: SqlServerConn = { query: async () => [], end: async () => {} };
    await expect(draftTargetSchemaSqlServer(empty, "dbo", ["ghost"])).rejects.toThrow(/no columns/);
  });
});
