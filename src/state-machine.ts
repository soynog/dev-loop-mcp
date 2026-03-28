/**
 * Pure state machine transitions for the dev-loop runner.
 *
 * `transition` is a pure function: it takes a state and an event, returns a
 * new state object, never mutates its inputs, and performs no I/O. Every call
 * refreshes `updatedAt` to the current ISO 8601 timestamp.
 */

import type { LoopState, Task, FailureInfo } from "./types.js";

// ---------------------------------------------------------------------------
// IllegalTransitionError
// ---------------------------------------------------------------------------

/** Thrown when a terminal state (DONE or FAILED) receives any event. */
export class IllegalTransitionError extends Error {
  constructor(phase: string) {
    super(`Cannot transition from terminal state ${phase}`);
    this.name = "IllegalTransitionError";
    // Restore prototype chain for instanceof checks across transpilation targets.
    Object.setPrototypeOf(this, IllegalTransitionError.prototype);
  }
}

// ---------------------------------------------------------------------------
// TransitionEvent discriminated union
// ---------------------------------------------------------------------------

/** All events that can drive the dev-loop state machine forward. */
export type TransitionEvent =
  | { type: "BranchCreated" }
  | { type: "TasksDecomposed"; tasks: Task[] }
  | { type: "TaskDone" }
  | { type: "TaskFailed"; failureReason: string }
  | { type: "BuildPassed" }
  | { type: "BuildFailed"; stderr: string }
  | { type: "DeployPassed" }
  | { type: "DeployFailed"; stderr: string }
  | { type: "IntegPassed" }
  | { type: "IntegFailed"; failures: FailureInfo[] }
  | { type: "IntegFixPassed" }
  | { type: "IntegFixFailed" }
  | { type: "QualityDone" }
  | { type: "TreeClean" }
  | { type: "PrCreated"; prUrl: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Maximum number of INTEG_FIX iterations before the run fails. */
const MAX_INTEG_FIX_ITERATIONS = 5;

/**
 * Return a shallow copy of `state` with `updatedAt` refreshed to now.
 * All transition branches spread from this base to guarantee no mutation.
 */
function base(state: LoopState): LoopState {
  return { ...state, updatedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Pure transition function
// ---------------------------------------------------------------------------

/**
 * Compute the next LoopState given the current state and an event.
 *
 * Throws `IllegalTransitionError` when called on a terminal state (DONE or
 * FAILED). All other state/event combinations not handled below are silently
 * ignored (returns a refreshed copy of the current state) — this matches the
 * open-world assumption for future events.
 */
export function transition(
  state: LoopState,
  event: TransitionEvent
): LoopState {
  // Terminal states reject all events.
  if (state.phase === "DONE" || state.phase === "FAILED") {
    throw new IllegalTransitionError(state.phase);
  }

  switch (state.phase) {
    case "INIT":
      return handleInit(state, event);

    case "DECOMPOSE":
      return handleDecompose(state, event);

    case "TDD_LOOP":
      return handleTddLoop(state, event);

    case "BUILD":
      return handleBuild(state, event);

    case "DEPLOY":
      return handleDeploy(state, event);

    case "INTEG_TEST":
      return handleIntegTest(state, event);

    case "INTEG_FIX":
      return handleIntegFix(state, event);

    case "QUALITY_REVIEW":
      return handleQualityReview(state, event);

    case "CLEAN_TREE_CHECK":
      return handleCleanTreeCheck(state, event);

    case "PUSH_AND_PR":
      return handlePushAndPr(state, event);

    default: {
      // Exhaustive check — TypeScript will error if a new phase is added
      // to LoopPhase without a corresponding case here.
      const _exhaustive: never = state.phase;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Per-phase handlers
// ---------------------------------------------------------------------------

function handleInit(
  state: LoopState,
  event: TransitionEvent
): LoopState {
  if (event.type !== "BranchCreated") return base(state);
  // Pre-loaded task list skips DECOMPOSE and goes straight to TDD_LOOP.
  const phase = state.tasks.length > 0 ? "TDD_LOOP" : "DECOMPOSE";
  return { ...base(state), phase };
}

function handleDecompose(
  state: LoopState,
  event: TransitionEvent
): LoopState {
  if (event.type !== "TasksDecomposed") return base(state);
  return { ...base(state), phase: "TDD_LOOP", tasks: event.tasks };
}

function handleTddLoop(
  state: LoopState,
  event: TransitionEvent
): LoopState {
  if (event.type === "TaskDone") {
    const isLastTask = state.currentTaskIdx >= state.tasks.length - 1;
    if (isLastTask) {
      return { ...base(state), phase: "BUILD" };
    }
    return { ...base(state), currentTaskIdx: state.currentTaskIdx + 1 };
  }

  if (event.type === "TaskFailed") {
    return {
      ...base(state),
      phase: "FAILED",
      failureReason: event.failureReason,
    };
  }

  return base(state);
}

function handleBuild(
  state: LoopState,
  event: TransitionEvent
): LoopState {
  if (event.type === "BuildPassed") return { ...base(state), phase: "DEPLOY" };
  if (event.type === "BuildFailed") return { ...base(state), phase: "FAILED" };
  return base(state);
}

function handleDeploy(
  state: LoopState,
  event: TransitionEvent
): LoopState {
  if (event.type === "DeployPassed")
    return { ...base(state), phase: "INTEG_TEST" };
  if (event.type === "DeployFailed")
    return { ...base(state), phase: "FAILED" };
  return base(state);
}

function handleIntegTest(
  state: LoopState,
  event: TransitionEvent
): LoopState {
  if (event.type === "IntegPassed")
    return { ...base(state), phase: "QUALITY_REVIEW" };
  if (event.type === "IntegFailed") {
    return {
      ...base(state),
      phase: "INTEG_FIX",
      integFixFailures: event.failures,
      integFixIteration: 0,
    };
  }
  return base(state);
}

function handleIntegFix(
  state: LoopState,
  event: TransitionEvent
): LoopState {
  if (event.type === "IntegFixPassed")
    return { ...base(state), phase: "QUALITY_REVIEW" };
  if (event.type === "IntegFixFailed") {
    if (state.integFixIteration >= MAX_INTEG_FIX_ITERATIONS) {
      return { ...base(state), phase: "FAILED" };
    }
    return {
      ...base(state),
      integFixIteration: state.integFixIteration + 1,
    };
  }
  return base(state);
}

function handleQualityReview(
  state: LoopState,
  event: TransitionEvent
): LoopState {
  if (event.type === "QualityDone")
    return { ...base(state), phase: "CLEAN_TREE_CHECK" };
  return base(state);
}

function handleCleanTreeCheck(
  state: LoopState,
  event: TransitionEvent
): LoopState {
  if (event.type === "TreeClean")
    return { ...base(state), phase: "PUSH_AND_PR" };
  return base(state);
}

function handlePushAndPr(
  state: LoopState,
  event: TransitionEvent
): LoopState {
  if (event.type === "PrCreated") {
    return { ...base(state), phase: "DONE", prUrl: event.prUrl };
  }
  return base(state);
}
