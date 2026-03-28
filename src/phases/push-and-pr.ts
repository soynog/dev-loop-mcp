/**
 * Phase executor for PUSH_AND_PR: pushes the current branch to origin and
 * opens a GitHub pull request via the `gh` CLI.
 *
 * The PR URL is parsed from the last non-empty line of `gh pr create` stdout,
 * which is the format used by the `gh` CLI.
 */
import type { LoopState, ShellAdapter } from "../types.js";
import type { TransitionEvent } from "../state-machine.js";

/**
 * Execute the PUSH_AND_PR phase: push the branch and open a PR, then return
 * `PrCreated` with the URL parsed from the `gh` CLI output.
 *
 * `prTitle` and `prBody` are passed through verbatim as the PR title and body.
 */
export async function execPushAndPr(
  state: LoopState,
  shell: ShellAdapter,
  repoRoot: string,
  prTitle: string,
  prBody: string
): Promise<TransitionEvent> {
  const branch = state.branch;

  await shell.exec(`git push origin ${branch}`, repoRoot);

  const ghResult = await shell.exec(
    `gh pr create --title "${prTitle}" --body "${prBody}"`,
    repoRoot
  );

  // gh outputs the PR URL as the last non-empty line of stdout.
  const prUrl = ghResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1) ?? "";

  return { type: "PrCreated", prUrl };
}
