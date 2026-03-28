import { describe, it, expect } from "vitest";
import { generateInstruction } from "./instructions.js";
import type { LoopState, DevLoopConfig, Task, FailureInfo } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    version: 1,
    runId: "test-run-id",
    branch: "claude/test-feature",
    phase: "INIT",
    tasks: [],
    currentTaskIdx: 0,
    integFixIteration: 0,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: "Add email validator",
    scope: "src/utils/email.ts",
    acceptance: "validateEmail returns true for valid emails and false otherwise",
    status: "pending",
    iterations: 0,
    ...overrides,
  };
}

const defaultConfig: DevLoopConfig = {
  buildCommand: "npm run build",
  testCommand: "npm test",
};

// ---------------------------------------------------------------------------
// INIT
// ---------------------------------------------------------------------------

describe("INIT instruction", () => {
  it("contains the branch name", () => {
    const state = makeState({ phase: "INIT", branch: "claude/my-feature" });
    const result = generateInstruction(state, defaultConfig);
    expect(result).toContain("claude/my-feature");
  });

  it("tells Claude Code to run git checkout -b", () => {
    const state = makeState({ phase: "INIT", branch: "claude/my-feature" });
    const result = generateInstruction(state, defaultConfig);
    expect(result).toContain("git checkout -b");
  });

  it("tells Claude Code to call advance_loop with BranchCreated", () => {
    const state = makeState({ phase: "INIT" });
    const result = generateInstruction(state, defaultConfig);
    expect(result).toContain("advance_loop");
    expect(result).toContain("BranchCreated");
  });
});

// ---------------------------------------------------------------------------
// DECOMPOSE — feature loop (no diagnosisContext)
// ---------------------------------------------------------------------------

describe("DECOMPOSE instruction (feature loop)", () => {
  it("includes the branch name as the thing to decompose", () => {
    const state = makeState({ phase: "DECOMPOSE", branch: "claude/add-auth-flow" });
    const result = generateInstruction(state, defaultConfig);
    expect(result).toContain("claude/add-auth-flow");
  });

  it("asks for tasks with id, title, scope, and acceptance", () => {
    const state = makeState({ phase: "DECOMPOSE" });
    const result = generateInstruction(state, defaultConfig);
    expect(result).toMatch(/id/i);
    expect(result).toMatch(/title/i);
    expect(result).toMatch(/scope/i);
    expect(result).toMatch(/acceptance/i);
  });

  it("tells Claude Code to call advance_loop with TasksDecomposed and a tasks array", () => {
    const state = makeState({ phase: "DECOMPOSE" });
    const result = generateInstruction(state, defaultConfig);
    expect(result).toContain("advance_loop");
    expect(result).toContain("TasksDecomposed");
    expect(result).toContain("tasks");
  });

  it("does NOT mention root causes or hypotheses", () => {
    const state = makeState({ phase: "DECOMPOSE" });
    const result = generateInstruction(state, defaultConfig);
    expect(result.toLowerCase()).not.toContain("hypothesis");
    expect(result.toLowerCase()).not.toContain("root cause");
  });
});

// ---------------------------------------------------------------------------
// DECOMPOSE — debug loop (diagnosisContext present)
// ---------------------------------------------------------------------------

describe("DECOMPOSE instruction (debug loop)", () => {
  it("includes the symptom from diagnosisContext", () => {
    const state = makeState({
      phase: "DECOMPOSE",
      diagnosisContext: "read_website returns failure on most real URLs",
    });
    const result = generateInstruction(state, defaultConfig);
    expect(result).toContain("read_website returns failure on most real URLs");
  });

  it("asks for root-cause hypotheses ordered by likelihood", () => {
    const state = makeState({
      phase: "DECOMPOSE",
      diagnosisContext: "server crashes on startup",
    });
    const result = generateInstruction(state, defaultConfig);
    expect(result.toLowerCase()).toMatch(/hypothesis|root.?cause|hypothes/);
    expect(result.toLowerCase()).toMatch(/likel|order|rank/);
  });

  it("tells Claude Code to call advance_loop with TasksDecomposed and a tasks array", () => {
    const state = makeState({
      phase: "DECOMPOSE",
      diagnosisContext: "some symptom",
    });
    const result = generateInstruction(state, defaultConfig);
    expect(result).toContain("advance_loop");
    expect(result).toContain("TasksDecomposed");
    expect(result).toContain("tasks");
  });
});

// ---------------------------------------------------------------------------
// TDD_LOOP
// ---------------------------------------------------------------------------

describe("TDD_LOOP instruction", () => {
  it("includes the task title, scope, and acceptance", () => {
    const task = makeTask({
      title: "Add email validator",
      scope: "src/utils/email.ts",
      acceptance: "validateEmail returns true for valid emails and false otherwise",
    });
    const state = makeState({ phase: "TDD_LOOP", tasks: [task], currentTaskIdx: 0 });
    const result = generateInstruction(state, defaultConfig);
    expect(result).toContain("Add email validator");
    expect(result).toContain("src/utils/email.ts");
    expect(result).toContain("validateEmail returns true for valid emails and false otherwise");
  });

  it("shows current task index and total task count", () => {
    const tasks = [
      makeTask({ id: 1, title: "Task A" }),
      makeTask({ id: 2, title: "Task B" }),
      makeTask({ id: 3, title: "Task C" }),
    ];
    const state = makeState({ phase: "TDD_LOOP", tasks, currentTaskIdx: 1 });
    const result = generateInstruction(state, defaultConfig);
    // Should show "2 of 3" or "2/3" or similar
    expect(result).toMatch(/2.{0,5}3/);
  });

  it("includes the configured testCommand", () => {
    const config: DevLoopConfig = { ...defaultConfig, testCommand: "yarn test --coverage" };
    const state = makeState({ phase: "TDD_LOOP", tasks: [makeTask()], currentTaskIdx: 0 });
    const result = generateInstruction(state, config);
    expect(result).toContain("yarn test --coverage");
  });

  it("describes the scenarios → failing tests → implement TDD cycle", () => {
    const state = makeState({ phase: "TDD_LOOP", tasks: [makeTask()], currentTaskIdx: 0 });
    const result = generateInstruction(state, defaultConfig);
    expect(result.toLowerCase()).toContain("scenario");
    expect(result.toLowerCase()).toMatch(/failing test|fail.*test|test.*fail/);
    expect(result.toLowerCase()).toContain("implement");
  });

  it("tells Claude Code to call advance_loop with TaskDone or TaskFailed", () => {
    const state = makeState({ phase: "TDD_LOOP", tasks: [makeTask()], currentTaskIdx: 0 });
    const result = generateInstruction(state, defaultConfig);
    expect(result).toContain("advance_loop");
    expect(result).toContain("TaskDone");
    expect(result).toContain("TaskFailed");
  });
});

// ---------------------------------------------------------------------------
// BUILD
// ---------------------------------------------------------------------------

describe("BUILD instruction", () => {
  it("includes the configured buildCommand", () => {
    const config: DevLoopConfig = { ...defaultConfig, buildCommand: "pnpm build" };
    const state = makeState({ phase: "BUILD" });
    const result = generateInstruction(state, config);
    expect(result).toContain("pnpm build");
  });

  it("tells Claude Code to call advance_loop with BuildPassed or BuildFailed", () => {
    const state = makeState({ phase: "BUILD" });
    const result = generateInstruction(state, defaultConfig);
    expect(result).toContain("advance_loop");
    expect(result).toContain("BuildPassed");
    expect(result).toContain("BuildFailed");
  });
});

// ---------------------------------------------------------------------------
// DEPLOY
// ---------------------------------------------------------------------------

describe("DEPLOY instruction (command configured)", () => {
  it("includes the configured deployCommand", () => {
    const config: DevLoopConfig = { ...defaultConfig, deployCommand: "fly deploy" };
    const state = makeState({ phase: "DEPLOY" });
    const result = generateInstruction(state, config);
    expect(result).toContain("fly deploy");
  });

  it("tells Claude Code to call advance_loop with DeployPassed or DeployFailed", () => {
    const config: DevLoopConfig = { ...defaultConfig, deployCommand: "npm run deploy" };
    const state = makeState({ phase: "DEPLOY" });
    const result = generateInstruction(state, config);
    expect(result).toContain("advance_loop");
    expect(result).toContain("DeployPassed");
    expect(result).toContain("DeployFailed");
  });
});

describe("DEPLOY instruction (no command configured)", () => {
  it("tells Claude Code to skip and call advance_loop with DeployPassed", () => {
    const state = makeState({ phase: "DEPLOY" });
    const result = generateInstruction(state, defaultConfig); // no deployCommand
    expect(result).toContain("advance_loop");
    expect(result).toContain("DeployPassed");
    expect(result.toLowerCase()).toMatch(/skip|no deploy/);
  });

  it("does not mention DeployFailed when there is no deploy command", () => {
    const state = makeState({ phase: "DEPLOY" });
    const result = generateInstruction(state, defaultConfig);
    expect(result).not.toContain("DeployFailed");
  });
});

// ---------------------------------------------------------------------------
// INTEG_TEST
// ---------------------------------------------------------------------------

describe("INTEG_TEST instruction (command configured)", () => {
  it("includes the configured integTestCommand", () => {
    const config: DevLoopConfig = { ...defaultConfig, integTestCommand: "npm run test:e2e" };
    const state = makeState({ phase: "INTEG_TEST" });
    const result = generateInstruction(state, config);
    expect(result).toContain("npm run test:e2e");
  });

  it("tells Claude Code to call advance_loop with IntegPassed or IntegFailed", () => {
    const config: DevLoopConfig = { ...defaultConfig, integTestCommand: "npm run test:e2e" };
    const state = makeState({ phase: "INTEG_TEST" });
    const result = generateInstruction(state, config);
    expect(result).toContain("advance_loop");
    expect(result).toContain("IntegPassed");
    expect(result).toContain("IntegFailed");
  });
});

describe("INTEG_TEST instruction (no command configured)", () => {
  it("tells Claude Code to skip and call advance_loop with IntegPassed", () => {
    const state = makeState({ phase: "INTEG_TEST" });
    const result = generateInstruction(state, defaultConfig); // no integTestCommand
    expect(result).toContain("advance_loop");
    expect(result).toContain("IntegPassed");
    expect(result.toLowerCase()).toMatch(/skip|no integ/);
  });

  it("does not mention IntegFailed when there is no integ test command", () => {
    const state = makeState({ phase: "INTEG_TEST" });
    const result = generateInstruction(state, defaultConfig);
    expect(result).not.toContain("IntegFailed");
  });
});

// ---------------------------------------------------------------------------
// INTEG_FIX
// ---------------------------------------------------------------------------

describe("INTEG_FIX instruction", () => {
  it("lists the failing test descriptions", () => {
    const failures: FailureInfo[] = [
      { testFile: "auth.test.ts", testName: "login flow", description: "POST /login returns 401 unexpectedly" },
      { testFile: "user.test.ts", testName: "profile fetch", description: "GET /user returns 500" },
    ];
    const state = makeState({ phase: "INTEG_FIX", integFixFailures: failures, integFixIteration: 0 });
    const result = generateInstruction(state, defaultConfig);
    expect(result).toContain("POST /login returns 401 unexpectedly");
    expect(result).toContain("GET /user returns 500");
  });

  it("shows the current attempt number", () => {
    const state = makeState({ phase: "INTEG_FIX", integFixIteration: 2 });
    const result = generateInstruction(state, defaultConfig);
    // integFixIteration is 0-indexed; the human-readable attempt is iteration + 1 = 3
    expect(result).toContain("3");
  });

  it("tells Claude Code NOT to read test files", () => {
    const state = makeState({ phase: "INTEG_FIX" });
    const result = generateInstruction(state, defaultConfig);
    expect(result.toLowerCase()).toMatch(/do not read test|not.*read.*test|never read test/);
  });

  it("tells Claude Code to call advance_loop with IntegFixPassed or IntegFixFailed", () => {
    const state = makeState({ phase: "INTEG_FIX" });
    const result = generateInstruction(state, defaultConfig);
    expect(result).toContain("advance_loop");
    expect(result).toContain("IntegFixPassed");
    expect(result).toContain("IntegFixFailed");
  });
});

// ---------------------------------------------------------------------------
// QUALITY_REVIEW
// ---------------------------------------------------------------------------

describe("QUALITY_REVIEW instruction", () => {
  it("tells Claude Code to run git diff main...HEAD", () => {
    const state = makeState({ phase: "QUALITY_REVIEW" });
    const result = generateInstruction(state, defaultConfig);
    expect(result).toContain("git diff main...HEAD");
  });

  it("mentions quality issues to look for", () => {
    const state = makeState({ phase: "QUALITY_REVIEW" });
    const result = generateInstruction(state, defaultConfig);
    expect(result.toLowerCase()).toMatch(/dead code|unused|type annotation|error handling/);
  });

  it("tells Claude Code NOT to add new features", () => {
    const state = makeState({ phase: "QUALITY_REVIEW" });
    const result = generateInstruction(state, defaultConfig);
    expect(result.toLowerCase()).toMatch(/do not add|not add.*feature|no new feature/);
  });

  it("tells Claude Code to call advance_loop with QualityDone", () => {
    const state = makeState({ phase: "QUALITY_REVIEW" });
    const result = generateInstruction(state, defaultConfig);
    expect(result).toContain("advance_loop");
    expect(result).toContain("QualityDone");
  });
});

// ---------------------------------------------------------------------------
// CLEAN_TREE_CHECK
// ---------------------------------------------------------------------------

describe("CLEAN_TREE_CHECK instruction", () => {
  it("tells Claude Code to run git status", () => {
    const state = makeState({ phase: "CLEAN_TREE_CHECK" });
    const result = generateInstruction(state, defaultConfig);
    expect(result).toContain("git status");
  });

  it("tells Claude Code to commit uncommitted files if present", () => {
    const state = makeState({ phase: "CLEAN_TREE_CHECK" });
    const result = generateInstruction(state, defaultConfig);
    expect(result.toLowerCase()).toMatch(/commit|git add/);
  });

  it("tells Claude Code to call advance_loop with TreeClean", () => {
    const state = makeState({ phase: "CLEAN_TREE_CHECK" });
    const result = generateInstruction(state, defaultConfig);
    expect(result).toContain("advance_loop");
    expect(result).toContain("TreeClean");
  });
});

// ---------------------------------------------------------------------------
// PUSH_AND_PR
// ---------------------------------------------------------------------------

describe("PUSH_AND_PR instruction", () => {
  it("contains the branch name for the push command", () => {
    const state = makeState({ phase: "PUSH_AND_PR", branch: "claude/cool-feature" });
    const result = generateInstruction(state, defaultConfig);
    expect(result).toContain("claude/cool-feature");
  });

  it("lists the completed task titles", () => {
    const tasks = [
      makeTask({ id: 1, title: "Add validator function" }),
      makeTask({ id: 2, title: "Wire validator to form" }),
    ];
    const state = makeState({ phase: "PUSH_AND_PR", tasks });
    const result = generateInstruction(state, defaultConfig);
    expect(result).toContain("Add validator function");
    expect(result).toContain("Wire validator to form");
  });

  it("tells Claude Code to run git push and gh pr create", () => {
    const state = makeState({ phase: "PUSH_AND_PR", branch: "claude/cool-feature" });
    const result = generateInstruction(state, defaultConfig);
    expect(result).toContain("git push");
    expect(result).toContain("gh pr create");
  });

  it("tells Claude Code to call advance_loop with PrCreated and the PR URL", () => {
    const state = makeState({ phase: "PUSH_AND_PR" });
    const result = generateInstruction(state, defaultConfig);
    expect(result).toContain("advance_loop");
    expect(result).toContain("PrCreated");
    expect(result).toContain("prUrl");
  });
});

// ---------------------------------------------------------------------------
// DONE (terminal)
// ---------------------------------------------------------------------------

describe("DONE instruction", () => {
  it("contains the PR URL", () => {
    const state = makeState({ phase: "DONE", prUrl: "https://github.com/org/repo/pull/42" });
    const result = generateInstruction(state, defaultConfig);
    expect(result).toContain("https://github.com/org/repo/pull/42");
  });

  it("indicates success", () => {
    const state = makeState({ phase: "DONE", prUrl: "https://github.com/org/repo/pull/1" });
    const result = generateInstruction(state, defaultConfig);
    expect(result.toLowerCase()).toMatch(/done|complete|success/);
  });
});

// ---------------------------------------------------------------------------
// FAILED (terminal)
// ---------------------------------------------------------------------------

describe("FAILED instruction", () => {
  it("contains the failure reason", () => {
    const state = makeState({ phase: "FAILED", failureReason: "5 TDD iterations exhausted" });
    const result = generateInstruction(state, defaultConfig);
    expect(result).toContain("5 TDD iterations exhausted");
  });

  it("indicates failure", () => {
    const state = makeState({ phase: "FAILED", failureReason: "build error" });
    const result = generateInstruction(state, defaultConfig);
    expect(result.toLowerCase()).toMatch(/fail|error/);
  });
});
