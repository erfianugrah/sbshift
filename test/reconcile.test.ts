import { describe, expect, test } from "bun:test";
import { type BucketRow, classifyRows, diffBuckets } from "../src/steps/reconcile.ts";

const mk = (entries: Array<[number, number, string]>): Map<number, BucketRow> =>
  new Map(entries.map(([b, n, h]) => [b, { b, n: BigInt(n), h }]));

describe("diffBuckets", () => {
  test("identical maps -> no mismatches", () => {
    const s = mk([
      [0, 10, "h0"],
      [1, 5, "h1"],
    ]);
    const t = mk([
      [0, 10, "h0"],
      [1, 5, "h1"],
    ]);
    expect(diffBuckets(s, t, 2)).toEqual([]);
  });

  test("detects hash difference in a bucket", () => {
    const s = mk([
      [0, 10, "h0"],
      [1, 5, "h1"],
    ]);
    const t = mk([
      [0, 10, "h0"],
      [1, 5, "DIFFERENT"],
    ]);
    expect(diffBuckets(s, t, 2)).toEqual([1]);
  });

  test("detects a bucket missing entirely on target", () => {
    const s = mk([
      [0, 10, "h0"],
      [1, 5, "h1"],
    ]);
    const t = mk([[0, 10, "h0"]]);
    expect(diffBuckets(s, t, 2)).toEqual([1]);
  });

  test("detects count difference even when hash coincides", () => {
    const s = mk([[0, 10, "h0"]]);
    const t = mk([[0, 11, "h0"]]);
    expect(diffBuckets(s, t, 1)).toEqual([0]);
  });
});

describe("classifyRows", () => {
  test("missing, extra, and hash_diff are each detected", () => {
    const s = new Map([
      ["pk1", "a"],
      ["pk2", "b"],
      ["pk3", "c"],
    ]);
    const t = new Map([
      ["pk1", "a"],
      ["pk2", "CHANGED"],
      ["pk4", "z"],
    ]);
    const out = classifyRows(s, t, 100);
    expect(out).toContainEqual({ pk: "pk2", kind: "hash_diff" });
    expect(out).toContainEqual({ pk: "pk3", kind: "missing_on_target" });
    expect(out).toContainEqual({ pk: "pk4", kind: "extra_on_target" });
    expect(out).toHaveLength(3);
  });

  test("identical maps -> empty", () => {
    const s = new Map([["pk1", "a"]]);
    const t = new Map([["pk1", "a"]]);
    expect(classifyRows(s, t, 100)).toEqual([]);
  });

  test("respects maxExamples cap", () => {
    const s = new Map([
      ["1", "a"],
      ["2", "a"],
      ["3", "a"],
    ]);
    const t = new Map<string, string>();
    expect(classifyRows(s, t, 2)).toHaveLength(2);
  });
});
