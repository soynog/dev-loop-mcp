/**
 * Shared type definitions for the dev-loop state machine.
 *
 * Every phase, entity, and dependency interface is declared here so that
 * runner, persistence, shell, and AI-worker modules all share a single
 * source of truth.
 */

// ---------------------------------------------------------------------------
// Phase and status enumerations
// ---------------------------------------------------------------------------

/** All possible phases of a dev-loop run, including terminal phases. */
export type LoopPhase =
  | "INIT"              // create branch, read context
  | "DECOMPOSE"         // AI: raw input → task list
  | "TDD_LOOP"          // AI: scenarios → tests → code (per task)
  | "BUILD"             // deterministic: run build command
  | "DEPLOY"            // deterministic: run deploy command (skipped if absent)
  | "INTEG_TEST"        // deterministic: run integ test command (skipped if absent)
  | "INTEG_FIX"         // AI: translate failures → coder → re-test
  | "QUALITY_REVIEW"    // AI: diff → quality coder
  | "CLEAN_TREE_CHECK"  // deterministic: git status --short
  | "PUSH_AND_PR"       // deterministic: git push + gh pr create
  | "DONE"              // terminal: PR URL recorded
  | "FAILED";           // terminal: error reason recorded

/** Lifecycle status of a single task within the loop. */
export type TaskStatus = "pending" | "in_progress" | "done" | "failed";

// ---------------------------------------------------------------------------
// Core entities
// ---------------------------------------------------------------------------

/** A single implementation task decomposed from the user's input. */
export interface Task {
  /** Monotonically increasing task identifier within a run. */
  id: number;
  /** Short human-readable name for the task. */
  title: string;
  /** File(s) affected by this task (comma-separated paths or glob). */
  scope: string;
  /** Plain-English definition of done for this task. */
  acceptance: string;
  /** Current lifecycle status of the task. */
  status: TaskStatus;
  /** Number of coding-agent iterations consumed for this task. */
  iterations: number;
}

/** Persistent state for an entire dev-loop run. Saved after every phase transition. */
export interface LoopState {
  /** Schema version — always the literal 1. Allows future migrations. */
  version: 1;
  /** UUID uniquely identifying this run. */
  runId: string;
  /** Git branch name for this run (e.g. "claude/fix-email-body"). */
  branch: string;
  /** Current phase of the state machine. */
  phase: LoopPhase;
  /** Ordered list of tasks for this run. */
  tasks: Task[];
  /** Index into `tasks` for the task currently being worked on. */
  currentTaskIdx: number;
  /** Number of INTEG_FIX → INTEG_TEST cycles attempted (max 5). */
  integFixIteration: number;
  /** Human-readable failure reason; populated only when phase is FAILED. */
  failureReason?: string;
  /** URL of the opened pull request; populated only when phase is DONE. */
  prUrl?: string;
  /** Failures captured from the INTEG_TEST phase; passed to INTEG_FIX for repair. */
  integFixFailures?: FailureInfo[];
  /** ISO 8601 timestamp when the run was created. */
  startedAt: string;
  /** ISO 8601 timestamp of the most recent state update. */
  updatedAt: string;
  /**
   * Original symptom description passed to start_debug_loop.
   * Present only when the loop was started via the debug tool.
   * Included in the PR body as diagnosis context.
   */
  diagnosisContext?: string;
}

// ---------------------------------------------------------------------------
// AI worker result types
// ---------------------------------------------------------------------------

/** Outcome of a single per-task TDD loop driven by the AI worker. */
export interface TddResult {
  /** Whether the task's tests passed within the allowed iterations. */
  success: boolean;
  /** Total number of coding-agent attempts made. */
  attempts: number;
  /** Human-readable reason for failure; populated only when success is false. */
  failureReason?: string;
}

/**
 * Natural-language description of a single failing integration test.
 * Raw assertion text is never included — only domain-level descriptions.
 */
export interface FailureInfo {
  /** Path to the test file that contains the failing test. */
  testFile: string;
  /** Full display name of the failing test case. */
  testName: string;
  /** Natural-language description of what went wrong (never raw assertion output). */
  description: string;
}

// ---------------------------------------------------------------------------
// Shell adapter
// ---------------------------------------------------------------------------

/** Result of executing a shell command. */
export interface ShellResult {
  /** Captured standard output from the command. */
  stdout: string;
  /** Captured standard error from the command. */
  stderr: string;
  /** Process exit code (0 means success). */
  exitCode: number;
}

/**
 * Abstraction over child-process execution.
 * Injected into the runner so tests can replace it with a mock.
 */
export interface ShellAdapter {
  /**
   * Execute a shell command and return its output.
   * Resolves even on non-zero exit codes — callers check exitCode.
   */
  exec(command: string, cwd?: string): Promise<ShellResult>;
}

// ---------------------------------------------------------------------------
// AI worker interface
// ---------------------------------------------------------------------------

/**
 * All AI junctures in the state machine, grouped into one injectable interface.
 * The production implementation uses the Anthropic SDK; tests inject a mock.
 */
export interface AIWorker {
  /** Juncture 1a: convert raw user input into a structured task list. */
  decompose(
    input: string,
    contextFiles: Record<string, string>
  ): Promise<Task[]>;

  /**
   * Juncture 1b: analyse a symptom + context files and return a ranked list of
   * root-cause hypotheses as TDD tasks, ordered from most to least likely.
   * Used by start_debug_loop before handing off to the standard TDD pipeline.
   */
  diagnose(
    symptom: string,
    contextFiles: Record<string, string>
  ): Promise<Task[]>;

  /** Juncture 2: run the per-task TDD loop (scenarios → tests → code). */
  runTddLoop(task: Task, repoRoot: string): Promise<TddResult>;

  /** Juncture 3: translate integ test failures to natural language, then fix. */
  fixIntegFailures(failures: FailureInfo[], repoRoot: string): Promise<void>;

  /** Juncture 4: review the full branch diff for code quality issues. */
  runQualityReview(diff: string, repoRoot: string): Promise<void>;

  /** Juncture 5: generate a pull request title and body from the final state. */
  generatePrBody(state: LoopState): Promise<{ title: string; body: string }>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Project-level configuration for the dev-loop. Loaded from dev-loop.config.json
 * at the project root. All fields have defaults so the file is optional.
 */
export interface DevLoopConfig {
  /** Shell command to build the project. Default: "npm run build". */
  buildCommand: string;
  /** Shell command to run unit tests. Default: "npm test". */
  testCommand: string;
  /** Shell command to deploy the project. If absent, the DEPLOY phase is skipped. */
  deployCommand?: string;
  /** Shell command to run integration tests. If absent, the INTEG_TEST phase is skipped. */
  integTestCommand?: string;
  /** Git branch name prefix. Default: "claude/". */
  branchPrefix?: string;
  /** Anthropic model ID to use. Default: "claude-sonnet-4-6". */
  model?: string;
}

// ---------------------------------------------------------------------------
// Runner dependencies
// ---------------------------------------------------------------------------

/**
 * All external dependencies required by the runner.
 * Bundled into a single struct so each phase function has a clean signature.
 */
export interface RunnerDeps {
  /** Shell command executor (real or mock). */
  shell: ShellAdapter;
  /** AI worker implementation (Anthropic SDK or mock). */
  aiWorker: AIWorker;
  /** Absolute path to the JSON file used for loop state persistence. */
  stateFilePath: string;
  /** Absolute path to the repository root. */
  repoRoot: string;
  /** Project configuration loaded from dev-loop.config.json. */
  config: DevLoopConfig;
}
