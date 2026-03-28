/**
 * Phase executor for INIT: creates or checks out the run's git branch.
 *
 * Attempts `git checkout -b <branch>` first. If that fails (branch already
 * exists), falls back to `git checkout <branch>`. Returns `BranchCreated`
 * on success.
 */
import type { LoopState, ShellAdapter } from "../types.js";
import type { TransitionEvent } from "../state-machine.js";

/**
 * Execute the INIT phase: create or switch to the branch in `state.branch`.
 * Uses `repoRoot` as the working directory for all shell commands.
 */
export async function execInit(
  state: LoopState,
  shell: ShellAdapter,
  repoRoot: string
): Promise<TransitionEvent> {
  const branch = state.branch;

  const createResult = await shell.exec(`git checkout -b ${branch}`, repoRoot);

  if (createResult.exitCode !== 0) {
    // Branch already exists — fall back to a plain checkout.
    await shell.exec(`git checkout ${branch}`, repoRoot);
  }

  return { type: "BranchCreated" };
}
