import { describe, expect, test } from "bun:test";
import { foreignLogicalSlots, type ReplicationSlotRow } from "../src/steps/checks.ts";

describe("foreignLogicalSlots - competing CDC consumers on the source", () => {
  test("no slots at all -> empty", () => {
    expect(foreignLogicalSlots([], "region_migration_slot")).toEqual([]);
  });

  test("only our own slot present -> empty (no false alarm on our own run)", () => {
    const rows: ReplicationSlotRow[] = [
      { slot_name: "region_migration_slot", plugin: "pgoutput", active: true },
    ];
    expect(foreignLogicalSlots(rows, "region_migration_slot")).toEqual([]);
  });

  test("a foreign slot (e.g. an Artie/ClickPipes/PeerDB CDC consumer) is surfaced", () => {
    const rows: ReplicationSlotRow[] = [
      { slot_name: "region_migration_slot", plugin: "pgoutput", active: true },
      { slot_name: "artie_prod_sync", plugin: "pgoutput", active: true },
    ];
    expect(foreignLogicalSlots(rows, "region_migration_slot")).toEqual([
      { slot_name: "artie_prod_sync", plugin: "pgoutput", active: true },
    ]);
  });

  test("multiple foreign slots are sorted by name", () => {
    const rows: ReplicationSlotRow[] = [
      { slot_name: "peerdb_slot", plugin: "pgoutput", active: false },
      { slot_name: "clickpipes_cdc", plugin: "wal2json", active: true },
    ];
    const out = foreignLogicalSlots(rows, "region_migration_slot");
    expect(out.map((r) => r.slot_name)).toEqual(["clickpipes_cdc", "peerdb_slot"]);
  });

  test("an inactive foreign slot is still reported (it can still hold WAL retention)", () => {
    const rows: ReplicationSlotRow[] = [
      { slot_name: "stale_debezium_slot", plugin: "pgoutput", active: false },
    ];
    const out = foreignLogicalSlots(rows, "region_migration_slot");
    expect(out).toHaveLength(1);
    expect(out[0]?.active).toBe(false);
  });

  test("null plugin (defensive - callers should filter to slot_type='logical' already)", () => {
    const rows: ReplicationSlotRow[] = [{ slot_name: "some_slot", plugin: null, active: true }];
    expect(foreignLogicalSlots(rows, "region_migration_slot")).toEqual([
      { slot_name: "some_slot", plugin: null, active: true },
    ]);
  });
});
