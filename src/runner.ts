/**
 * Runner composition layer for the dev-loop state machine.
 *
 * `runOnce` dispatches to the correct phase handler based on the current state
 * phase, produces a TransitionEvent, advances the state via `transition`, and
 * persists the new state to disk. `runLoop` calls `runOnce` repeatedly until
 * the terminal DONE or FAILED phase is reached.
 */

import type { LoopState, RunnerDeps } from "./types.js";
import {
  execInit,
  execBuild,
  execDeploy,
  execIntegTest,
  execCleanTreeCheck,
  execPushAndPr,
} from "./phases/index.js";
import { transition, IllegalTransitionError } from "./state-machine.js";
import type { TransitionEvent } from "./state-machine.js";
import { saveState } from "./persistence.js";

// ---------------------------------------------------------------------------
// runOnce
// ---------------------------------------------------------------------------

/**
 * Execute a single phase of the dev-loop state machine.
 *
 * Dispatches to the correct phase handler based on `state.phase`, calls
 * `transition` with the resulting event, persists the next state, and returns
 * it. Throws `IllegalTransitionError` if called on a terminal state.
 */
export async function runOnce(
  state: LoopState,
  deps: RunnerDeps
): Promise<LoopState> {
  const { shell, aiWorker, stateFilePath, repoRoot, config } = deps;

  // Terminal states cannot be advanced — throw immediately.
  if (state.phase === "DONE" || state.phase === "FAILED") {
    throw new IllegalTransitionError(state.phase);
  }

  let event: TransitionEvent;

  switch (state.phase) {
    case "INIT": {
      event = await execInit(state, shell, repoRoot);
      break;
    }

    case "DECOMPOSE": {
      // Assumption: branch name is used as the task decomposition input;
      // contextFiles is empty — the runner does not pre-load context files.
      const tasks = await aiWorker.decompose(state.branch, {});
      event = { type: "TasksDecomposed", tasks };
      break;
    }

    case "TDD_LOOP": {
      const task = state.tasks[state.currentTaskIdx];
      const result = await aiWorker.runTddLoop(task, repoRoot);
      if (result.success) {
        event = { type: "TaskDone" };
      } else {
        event = {
          type: "TaskFailed",
          failureReason: result.failureReason ?? "task failed without a reason",
        };
      }
      break;
    }

    case "BUILD": {
      event = await execBuild(state, shell, repoRoot, config);
      break;
    }

    case "DEPLOY": {
      event = await execDeploy(state, shell, repoRoot, config);
      break;
    }

    case "INTEG_TEST": {
      event = await execIntegTest(state, shell, repoRoot, config);
      break;
    }

    case "INTEG_FIX": {
      // After fixIntegFailures resolves, produce IntegFixPassed.
      // Retry counting is handled by the state machine (integFixIteration).
      await aiWorker.fixIntegFailures(state.integFixFailures ?? [], repoRoot);
      event = { type: "IntegFixPassed" };
      break;
    }

    case "QUALITY_REVIEW": {
      // Get the full branch diff, then hand it to the AI quality reviewer.
      const diffResult = await shell.exec("git diff main...HEAD", repoRoot);
      await aiWorker.runQualityReview(diffResult.stdout, repoRoot);
      event = { type: "QualityDone" };
      break;
    }

    case "CLEAN_TREE_CHECK": {
      event = await execCleanTreeCheck(state, shell, repoRoot);
      break;
    }

    case "PUSH_AND_PR": {
      const { title, body } = await aiWorker.generatePrBody(state);
      event = await execPushAndPr(state, shell, repoRoot, title, body);
      break;
    }

    default: {
      // Exhaustive check — TypeScript errors if a new phase is added without a case.
      const _exhaustive: never = state.phase;
      throw new Error(`runOnce: unhandled phase: ${String(_exhaustive)}`);
    }
  }

  const nextState = transition(state, event);
  await saveState(stateFilePath, nextState);
  return nextState;
}

// ---------------------------------------------------------------------------
// runLoop
// ---------------------------------------------------------------------------

/**
 * Drive the dev-loop state machine to completion.
 *
 * Calls `runOnce` repeatedly until the phase is DONE or FAILED, then returns
 * the final state. Callers can inspect `finalState.phase` to determine outcome.
 */
export async function runLoop(
  initialState: LoopState,
  deps: RunnerDeps
): Promise<LoopState> {
  let state = initialState;

  while (state.phase !== "DONE" && state.phase !== "FAILED") {
    state = await runOnce(state, deps);
  }

  return state;
}
