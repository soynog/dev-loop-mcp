/**
 * Phase executor for DEPLOY: runs the configured deploy command and maps the
 * exit code to `DeployPassed` or `DeployFailed`.
 *
 * If `config.deployCommand` is absent or empty, the phase is skipped and
 * `DeployPassed` is returned immediately. This allows projects without a
 * deploy step to proceed through the state machine unchanged.
 */
import type { LoopState, ShellAdapter, DevLoopConfig } from "../types.js";
import type { TransitionEvent } from "../state-machine.js";

/**
 * Execute the DEPLOY phase: run `config.deployCommand` if present, or skip.
 * Returns the corresponding transition event based on the exit code.
 */
export async function execDeploy(
  _state: LoopState,
  shell: ShellAdapter,
  repoRoot: string,
  config: DevLoopConfig
): Promise<TransitionEvent> {
  // Skip deploy if no command is configured.
  if (!config.deployCommand) {
    return { type: "DeployPassed" };
  }

  const result = await shell.exec(config.deployCommand, repoRoot);

  if (result.exitCode === 0) {
    return { type: "DeployPassed" };
  }

  return { type: "DeployFailed", stderr: result.stderr };
}
