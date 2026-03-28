/**
 * Phase executor for BUILD: runs the configured build command and maps the
 * exit code to a `BuildPassed` or `BuildFailed` event.
 *
 * The build command is taken from `config.buildCommand` so any project's
 * build tooling is supported.
 */
import type { LoopState, ShellAdapter, DevLoopConfig } from "../types.js";
import type { TransitionEvent } from "../state-machine.js";

/**
 * Execute the BUILD phase: run `config.buildCommand` and return the corresponding
 * transition event based on the exit code.
 */
export async function execBuild(
  _state: LoopState,
  shell: ShellAdapter,
  repoRoot: string,
  config: DevLoopConfig
): Promise<TransitionEvent> {
  const result = await shell.exec(config.buildCommand, repoRoot);

  if (result.exitCode === 0) {
    return { type: "BuildPassed" };
  }

  return { type: "BuildFailed", stderr: result.stderr };
}
