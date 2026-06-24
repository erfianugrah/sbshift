import { describe, expect, test } from "bun:test";
import { preppableEngines, sourcePrep, sourcePrepFor } from "../src/kb/engine-prep.ts";
import { SourcePrepItems } from "../src/kb/schema.ts";

describe("source-prep catalog", () => {
  test("the whole catalog parses against the schema", () => {
    expect(() => SourcePrepItems.parse(sourcePrep)).not.toThrow();
  });

  test("ids are unique and engine-prefixed", () => {
    const ids = sourcePrep.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const i of sourcePrep) expect(i.id.startsWith(`${i.engine}.`)).toBe(true);
  });

  test("every item carries a drift-checkable provenance source + ISO-dated lastSynced", () => {
    for (const i of sourcePrep) {
      expect(i.provenance.source).toMatch(/^(\/docs\/|https?:\/\/)/);
      expect(i.provenance.lastSynced).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test("a guided/fail item never auto-applies and gates its phase", () => {
    const guided = sourcePrep.filter((i) => i.klass === "guided");
    for (const i of guided) expect(i.severity).toBe("fail");
  });
});

describe("preppableEngines", () => {
  test("lists the heterogeneous engines that have a playbook, deduped", () => {
    const engines = preppableEngines();
    expect(new Set(engines)).toEqual(new Set(["mysql"]));
    expect(engines.length).toBe(new Set(engines).size);
  });
});

describe("MySQL source-prep playbook (§7)", () => {
  const items = sourcePrepFor("mysql");
  const byId = (id: string) => {
    const found = items.find((i) => i.id === id);
    if (!found) throw new Error(`missing mysql item: ${id}`);
    return found;
  };

  test("covers the six source-prep enablement items plus schema-translation + identity-resync", () => {
    expect(items.map((i) => i.id)).toEqual([
      "mysql.user_grants",
      "mysql.binlog_enabled",
      "mysql.gtid_mode",
      "mysql.binlog_retention",
      "mysql.binlog_row_value_options",
      "mysql.schema_translation",
      "mysql.identity_resync",
    ]);
  });

  test("binlog item demands ROW format + FULL row image (the Debezium hard requirement)", () => {
    const binlog = byId("mysql.binlog_enabled");
    expect(binlog.severity).toBe("fail");
    expect(binlog.guidance).toContain("binlog_format    = ROW");
    expect(binlog.guidance).toContain("binlog_row_image = FULL");
    expect(binlog.verify?.expect).toContain("ROW");
  });

  test("CDC user grants include the two replication privileges Debezium needs", () => {
    const grants = byId("mysql.user_grants");
    expect(grants.guidance).toContain("REPLICATION SLAVE");
    expect(grants.guidance).toContain("REPLICATION CLIENT");
  });

  test("schema-translation is the guided heart: snapshot phase, fail, never auto-applies", () => {
    const st = byId("mysql.schema_translation");
    expect(st.phase).toBe("snapshot");
    expect(st.klass).toBe("guided");
    expect(st.severity).toBe("fail");
    expect(st.guidance).toContain("Never auto-applies");
    expect(st.detect).toBeUndefined(); // a human-ratified draft, not a probe
  });

  test("identity-resync mirrors native cutover sequence-resync (cutover phase, auto)", () => {
    const ir = byId("mysql.identity_resync");
    expect(ir.phase).toBe("cutover");
    expect(ir.klass).toBe("auto");
    expect(ir.guidance).toContain("MAX(pk)+1");
  });
});
