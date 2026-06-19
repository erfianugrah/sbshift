import { describe, expect, test } from "bun:test";
import { phasesThrough } from "../src/steps/run.ts";

describe("phasesThrough", () => {
  test("default reconcile range excludes cutover", () => {
    expect(phasesThrough("reconcile")).toEqual(["preflight", "replicate", "watch", "reconcile"]);
  });

  test("watch range stops at watch", () => {
    expect(phasesThrough("watch")).toEqual(["preflight", "replicate", "watch"]);
  });

  test("replicate range", () => {
    expect(phasesThrough("replicate")).toEqual(["preflight", "replicate"]);
  });

  test("cutover range is the full pipeline", () => {
    expect(phasesThrough("cutover")).toEqual([
      "preflight",
      "replicate",
      "watch",
      "reconcile",
      "cutover",
    ]);
  });

  test("preflight alone", () => {
    expect(phasesThrough("preflight")).toEqual(["preflight"]);
  });

  test("unknown phase throws", () => {
    // @ts-expect-error testing the runtime guard with an invalid phase
    expect(() => phasesThrough("bogus")).toThrow();
  });
});
