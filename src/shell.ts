/**
 * Shell adapter implementations for the dev-loop state machine.
 *
 * Provides a `RealShellAdapter` that wraps `node:child_process` exec, and a
 * `MockShellAdapter` for use in tests. Both implement the `ShellAdapter`
 * interface from `types.ts`.
 */
import { exec as cpExec } from "node:child_process";
import type { ShellAdapter, ShellResult } from "./types.js";

// ---------------------------------------------------------------------------
// Custom error
// ---------------------------------------------------------------------------

/**
 * Thrown by `MockShellAdapter` when exec is called with a command that was not
 * registered in the response map. Prevents tests from silently running unexpected commands.
 */
export class UnexpectedCommandError extends Error {
  constructor(command: string) {
    super(`UnexpectedCommandError: no response configured for command: ${command}`);
    this.name = "UnexpectedCommandError";
    // Maintain correct prototype chain when compiled to ES5 targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// RealShellAdapter
// ---------------------------------------------------------------------------

/**
 * Executes shell commands via `node:child_process` exec, returning a
 * `ShellResult`. Never throws — non-zero exit codes are captured in `exitCode`.
 */
export class RealShellAdapter implements ShellAdapter {
  /**
   * Runs `command` as a shell command, optionally in `cwd`.
   * Resolves with `{ stdout, stderr, exitCode }` regardless of exit code.
   */
  exec(command: string, cwd?: string): Promise<ShellResult> {
    return new Promise((resolve) => {
      const options = cwd ? { cwd } : {};

      cpExec(command, options, (error, stdout, stderr) => {
        // error is non-null for non-zero exits; extract exitCode from it.
        const exitCode = error?.code ?? 0;
        resolve({ stdout, stderr, exitCode });
      });
    });
  }
}

// ---------------------------------------------------------------------------
// MockShellAdapter
// ---------------------------------------------------------------------------

/**
 * Test double for `ShellAdapter`. Returns pre-configured `ShellResult` values
 * by exact command string. Throws `UnexpectedCommandError` for any command
 * not registered at construction time, preventing accidental real shell calls.
 */
export class MockShellAdapter implements ShellAdapter {
  private readonly responses: Map<string, ShellResult>;

  /**
   * Accepts a plain object or a `Map<string, ShellResult>` mapping command
   * strings to the results that `exec` should return.
   */
  constructor(responses: Record<string, ShellResult> | Map<string, ShellResult>) {
    if (responses instanceof Map) {
      this.responses = responses;
    } else {
      this.responses = new Map(Object.entries(responses));
    }
  }

  /**
   * Returns the configured `ShellResult` for the exact command string.
   * Throws `UnexpectedCommandError` if the command was not registered.
   * The `cwd` parameter is accepted to satisfy the interface but does not
   * affect result lookup.
   */
  exec(command: string, _cwd?: string): Promise<ShellResult> {
    const result = this.responses.get(command);

    if (result === undefined) {
      return Promise.reject(new UnexpectedCommandError(command));
    }

    return Promise.resolve(result);
  }
}
