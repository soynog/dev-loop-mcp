/**
 * Public library exports for dev-loop-mcp.
 *
 * When used as a library (rather than via the MCP server binary), consumers
 * can import these directly to compose their own runners or extend the loop.
 */

// Types
export type {
  LoopPhase,
  TaskStatus,
  Task,
  LoopState,
  TddResult,
  FailureInfo,
  ShellResult,
  ShellAdapter,
  AIWorker,
  DevLoopConfig,
  RunnerDeps,
} from "./types.js";

// State machine
export { transition, IllegalTransitionError } from "./state-machine.js";
export type { TransitionEvent } from "./state-machine.js";

// Persistence
export { saveState, loadState, StateLoadError } from "./persistence.js";

// Shell adapters
export {
  RealShellAdapter,
  MockShellAdapter,
  UnexpectedCommandError,
} from "./shell.js";

// AI worker
export { AnthropicDevWorker, DecomposeError } from "./ai-worker.js";
export type { AnthropicClientLike } from "./ai-worker.js";

// Runner
export { runOnce, runLoop } from "./runner.js";

// Config
export { loadConfig, defaultConfig } from "./config.js";

// MCP server
export { startMcpServer } from "./mcp-server.js";

// Phase executors
export {
  execInit,
  execBuild,
  execDeploy,
  execIntegTest,
  execCleanTreeCheck,
  execPushAndPr,
} from "./phases/index.js";
