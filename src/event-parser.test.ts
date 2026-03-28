import { describe, it, expect } from "vitest";
import { parseEvent } from "./event-parser.js";

// ---------------------------------------------------------------------------
// Simple events (no extra payload)
// ---------------------------------------------------------------------------

describe("parseEvent — simple events", () => {
  it("parses BranchCreated", () => {
    expect(parseEvent({ event: "BranchCreated" })).toEqual({ type: "BranchCreated" });
  });

  it("parses TaskDone", () => {
    expect(parseEvent({ event: "TaskDone" })).toEqual({ type: "TaskDone" });
  });

  it("parses BuildPassed", () => {
    expect(parseEvent({ event: "BuildPassed" })).toEqual({ type: "BuildPassed" });
  });

  it("parses DeployPassed", () => {
    expect(parseEvent({ event: "DeployPassed" })).toEqual({ type: "DeployPassed" });
  });

  it("parses IntegPassed", () => {
    expect(parseEvent({ event: "IntegPassed" })).toEqual({ type: "IntegPassed" });
  });

  it("parses IntegFixPassed", () => {
    expect(parseEvent({ event: "IntegFixPassed" })).toEqual({ type: "IntegFixPassed" });
  });

  it("parses IntegFixFailed", () => {
    expect(parseEvent({ event: "IntegFixFailed" })).toEqual({ type: "IntegFixFailed" });
  });

  it("parses QualityDone", () => {
    expect(parseEvent({ event: "QualityDone" })).toEqual({ type: "QualityDone" });
  });

  it("parses TreeClean", () => {
    expect(parseEvent({ event: "TreeClean" })).toEqual({ type: "TreeClean" });
  });
});

// ---------------------------------------------------------------------------
// Events with payload
// ---------------------------------------------------------------------------

describe("parseEvent — events with payload", () => {
  it("parses TasksDecomposed with a tasks array", () => {
    const tasks = [
      { id: 1, title: "Task A", scope: "src/a.ts", acceptance: "A works", status: "pending", iterations: 0 },
    ];
    const result = parseEvent({ event: "TasksDecomposed", tasks });
    expect(result).toEqual({ type: "TasksDecomposed", tasks });
  });

  it("parses TaskFailed with failureReason", () => {
    const result = parseEvent({ event: "TaskFailed", failureReason: "5 iterations exhausted" });
    expect(result).toEqual({ type: "TaskFailed", failureReason: "5 iterations exhausted" });
  });

  it("parses BuildFailed with stderr", () => {
    const result = parseEvent({ event: "BuildFailed", stderr: "error TS2345: Argument..." });
    expect(result).toEqual({ type: "BuildFailed", stderr: "error TS2345: Argument..." });
  });

  it("parses DeployFailed with stderr", () => {
    const result = parseEvent({ event: "DeployFailed", stderr: "connection refused" });
    expect(result).toEqual({ type: "DeployFailed", stderr: "connection refused" });
  });

  it("parses IntegFailed with failures array", () => {
    const failures = [
      { testFile: "auth.test.ts", testName: "login", description: "returns 401" },
    ];
    const result = parseEvent({ event: "IntegFailed", failures });
    expect(result).toEqual({ type: "IntegFailed", failures });
  });

  it("parses PrCreated with prUrl", () => {
    const result = parseEvent({ event: "PrCreated", prUrl: "https://github.com/org/repo/pull/7" });
    expect(result).toEqual({ type: "PrCreated", prUrl: "https://github.com/org/repo/pull/7" });
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe("parseEvent — error cases", () => {
  it("throws when event field is missing", () => {
    expect(() => parseEvent({})).toThrow(/event/i);
  });

  it("throws when event field is not a string", () => {
    expect(() => parseEvent({ event: 42 })).toThrow();
  });

  it("throws a descriptive error for an unknown event name", () => {
    expect(() => parseEvent({ event: "SomethingMadeUp" })).toThrow(/SomethingMadeUp/);
  });
});
