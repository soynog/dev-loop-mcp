/**
 * Re-exports all deterministic phase executors for the dev-loop state machine.
 *
 * Each executor accepts a `LoopState`, a `ShellAdapter`, the `repoRoot`, and
 * (where applicable) a `DevLoopConfig`, and returns a `Promise<TransitionEvent>`.
 * They contain no AI calls and are fully unit-testable with `MockShellAdapter`.
 */
export { execInit } from "./init.js";
export { execBuild } from "./build.js";
export { execDeploy } from "./deploy.js";
export { execIntegTest } from "./integ-test.js";
export { execCleanTreeCheck } from "./clean-tree.js";
export { execPushAndPr } from "./push-and-pr.js";
