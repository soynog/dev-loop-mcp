/**
 * Instruction generator for the handback architecture.
 *
 * `generateInstruction` maps a LoopState + DevLoopConfig to a natural-language
 * string that tells the calling AI (Claude Code) exactly what to do next and
 * which `advance_loop` event to call when done.
 *
 * This is a pure function — no I/O, no API calls.
 */

import type { LoopState, DevLoopConfig } from "./types.js";

/**
 * Generate the instruction string for the current phase.
 * Terminal phases (DONE, FAILED) return a summary rather than an action.
 */
export function generateInstruction(state: LoopState, config: DevLoopConfig): string {
  switch (state.phase) {
    case "INIT":
      return initInstruction(state);
    case "DECOMPOSE":
      return decomposeInstruction(state);
    case "TDD_LOOP":
      return tddLoopInstruction(state, config);
    case "BUILD":
      return buildInstruction(config);
    case "DEPLOY":
      return deployInstruction(config);
    case "INTEG_TEST":
      return integTestInstruction(config);
    case "INTEG_FIX":
      return integFixInstruction(state);
    case "QUALITY_REVIEW":
      return qualityReviewInstruction();
    case "CLEAN_TREE_CHECK":
      return cleanTreeCheckInstruction();
    case "PUSH_AND_PR":
      return pushAndPrInstruction(state);
    case "DONE":
      return `Loop complete! PR: ${state.prUrl ?? "(no URL recorded)"}`;
    case "FAILED":
      return `Loop failed: ${state.failureReason ?? "(no reason recorded)"}`;
    default: {
      const _exhaustive: never = state.phase;
      return `Unknown phase: ${String(_exhaustive)}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Per-phase instruction builders
// ---------------------------------------------------------------------------

function initInstruction(state: LoopState): string {
  return [
    `Create the git branch for this loop:`,
    ``,
    `  git checkout -b ${state.branch}`,
    ``,
    `Then call \`advance_loop\` with:`,
    `  { "event": "BranchCreated" }`,
  ].join("\n");
}

function decomposeInstruction(state: LoopState): string {
  if (state.diagnosisContext) {
    return [
      `Diagnose the following symptom and identify root-cause hypotheses:`,
      ``,
      `  "${state.diagnosisContext}"`,
      ``,
      `Read any relevant files in the repository. Produce a ranked list of`,
      `root-cause hypotheses ordered from most to least likely. Format each`,
      `hypothesis as a TDD task with these fields:`,
      `  - id (number)`,
      `  - title (short name for the hypothesis)`,
      `  - scope (affected files or modules)`,
      `  - acceptance (plain-English description of correct behaviour after the fix)`,
      ``,
      `Then call \`advance_loop\` with:`,
      `  { "event": "TasksDecomposed", "tasks": [ ... ] }`,
    ].join("\n");
  }

  return [
    `Decompose the following into an ordered list of independently testable TDD tasks:`,
    ``,
    `  "${state.branch}"`,
    ``,
    `Each task should be small enough for a single TDD cycle. For each task provide:`,
    `  - id (number)`,
    `  - title (short name)`,
    `  - scope (affected files or modules)`,
    `  - acceptance (plain-English success definition)`,
    ``,
    `Then call \`advance_loop\` with:`,
    `  { "event": "TasksDecomposed", "tasks": [ ... ] }`,
  ].join("\n");
}

function tddLoopInstruction(state: LoopState, config: DevLoopConfig): string {
  const task = state.tasks[state.currentTaskIdx];
  const taskNum = state.currentTaskIdx + 1;
  const total = state.tasks.length;
  const kebab = task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  return [
    `Run a TDD cycle for task ${taskNum} of ${total}:`,
    ``,
    `  Title:       ${task.title}`,
    `  Scope:       ${task.scope}`,
    `  Acceptance:  ${task.acceptance}`,
    ``,
    `Follow these steps exactly:`,
    `1. Write a scenarios file to scenarios/scenarios-${kebab}.md`,
    `2. Commit: git add -A && git commit -m 'test: add scenarios for ${task.title}'`,
    `3. Write failing tests to ${kebab}.test.ts (tests must fail before any implementation)`,
    `4. Run: ${config.testCommand}  — confirm tests fail (red)`,
    `5. Commit: git add -A && git commit -m 'test: add failing tests for ${task.title}'`,
    `6. Implement the feature. Do NOT read test files to infer the implementation.`,
    `7. Run: ${config.testCommand}`,
    `   - If passing: git add -A && git commit -m 'feat: implement ${task.title}'`,
    `   - If failing: iterate up to 5 times, then report TaskFailed`,
    ``,
    `Then call \`advance_loop\` with one of:`,
    `  { "event": "TaskDone" }`,
    `  { "event": "TaskFailed", "failureReason": "..." }`,
  ].join("\n");
}

function buildInstruction(config: DevLoopConfig): string {
  return [
    `Build the project:`,
    ``,
    `  ${config.buildCommand}`,
    ``,
    `Then call \`advance_loop\` with one of:`,
    `  { "event": "BuildPassed" }`,
    `  { "event": "BuildFailed", "stderr": "..." }`,
  ].join("\n");
}

function deployInstruction(config: DevLoopConfig): string {
  if (!config.deployCommand) {
    return [
      `No deploy command configured — skip this phase.`,
      ``,
      `Call \`advance_loop\` with:`,
      `  { "event": "DeployPassed" }`,
    ].join("\n");
  }

  return [
    `Deploy the project:`,
    ``,
    `  ${config.deployCommand}`,
    ``,
    `Then call \`advance_loop\` with one of:`,
    `  { "event": "DeployPassed" }`,
    `  { "event": "DeployFailed", "stderr": "..." }`,
  ].join("\n");
}

function integTestInstruction(config: DevLoopConfig): string {
  if (!config.integTestCommand) {
    return [
      `No integ test command configured — skip this phase.`,
      ``,
      `Call \`advance_loop\` with:`,
      `  { "event": "IntegPassed" }`,
    ].join("\n");
  }

  return [
    `Run integration tests:`,
    ``,
    `  ${config.integTestCommand}`,
    ``,
    `Then call \`advance_loop\` with one of:`,
    `  { "event": "IntegPassed" }`,
    `  { "event": "IntegFailed", "failures": [ { "testFile": "...", "testName": "...", "description": "..." } ] }`,
  ].join("\n");
}

function integFixInstruction(state: LoopState): string {
  const attempt = state.integFixIteration + 1;
  const failureLines = (state.integFixFailures ?? [])
    .map((f) => `  - ${f.description}`)
    .join("\n");

  return [
    `Fix failing integration tests (attempt ${attempt} of 5):`,
    ``,
    failureLines || `  (no failure details recorded)`,
    ``,
    `Read implementation files to diagnose the root cause.`,
    `Do not read test files — fix the implementation code only.`,
    ``,
    `Then call \`advance_loop\` with one of:`,
    `  { "event": "IntegFixPassed" }`,
    `  { "event": "IntegFixFailed" }`,
  ].join("\n");
}

function qualityReviewInstruction(): string {
  return [
    `Review the branch diff for code quality issues and fix them:`,
    ``,
    `1. Run: git diff main...HEAD`,
    `2. Fix any issues found:`,
    `   - Dead code (unused variables, functions, imports)`,
    `   - Overly complex logic that can be simplified`,
    `   - Incorrect or missing type annotations`,
    `   - Missing error handling at system boundaries`,
    `   - Public behaviour without test coverage`,
    `3. Do not add new features — make the smallest changes necessary.`,
    ``,
    `Then call \`advance_loop\` with:`,
    `  { "event": "QualityDone" }`,
  ].join("\n");
}

function cleanTreeCheckInstruction(): string {
  return [
    `Ensure the working tree is clean before opening a PR:`,
    ``,
    `1. Run: git status --short`,
    `2. If there are uncommitted files:`,
    `   git add -A && git commit -m 'chore: clean tree before PR'`,
    ``,
    `Then call \`advance_loop\` with:`,
    `  { "event": "TreeClean" }`,
  ].join("\n");
}

function pushAndPrInstruction(state: LoopState): string {
  const taskList = state.tasks.map((t) => `  - ${t.title}`).join("\n");

  return [
    `Push the branch and open a pull request:`,
    ``,
    `1. git push origin ${state.branch}`,
    `2. Write a PR title and body summarising these completed tasks:`,
    taskList || `  (no tasks)`,
    `3. gh pr create --title "<your title>" --body "<your body>"`,
    ``,
    `Then call \`advance_loop\` with:`,
    `  { "event": "PrCreated", "prUrl": "<the URL printed by gh pr create>" }`,
  ].join("\n");
}
