/**
 * Phase executor for CLEAN_TREE_CHECK: ensures the git working tree is clean
 * before creating a PR.
 *
 * If `git status --short` returns non-empty output, any stray files are staged
 * and committed automatically so they are included in the PR rather than lost.
 */
import type { LoopState, ShellAdapter } from "../types.js";
import type { TransitionEvent } from "../state-machine.js";

/** Commit message used when stray files are found and auto-committed. */
const STRAY_FILES_COMMIT_MSG = "chore: commit stray files before PR";

/**
 * Execute the CLEAN_TREE_CHECK phase: check for uncommitted changes and commit
 * them if present, then return `TreeClean`.
 */
export async function execCleanTreeCheck(
  _state: LoopState,
  shell: ShellAdapter,
  repoRoot: string
): Promise<TransitionEvent> {
  const statusResult = await shell.exec("git status --short", repoRoot);

  if (statusResult.stdout.trim() !== "") {
    // Stray files detected — stage and commit them before proceeding.
    await shell.exec("git add -A", repoRoot);
    await shell.exec(`git commit -m "${STRAY_FILES_COMMIT_MSG}"`, repoRoot);
  }

  return { type: "TreeClean" };
}
