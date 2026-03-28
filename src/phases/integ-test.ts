/**
 * Phase executor for INTEG_TEST: runs the configured integration test command,
 * parses its output, and returns either an `IntegPassed` or `IntegFailed`
 * transition event.
 *
 * If `config.integTestCommand` is absent or empty, the phase is skipped and
 * `IntegPassed` is returned immediately.
 *
 * Failure parsing: attempts to parse vitest JSON from stdout. If that fails,
 * creates a single FailureInfo entry with stdout/stderr as the description
 * (truncated to 2000 characters) so the INTEG_FIX phase always receives
 * actionable information.
 */
import type { LoopState, ShellAdapter, FailureInfo, DevLoopConfig } from "../types.js";
import type { TransitionEvent } from "../state-machine.js";

// ---------------------------------------------------------------------------
// Vitest JSON shape
// ---------------------------------------------------------------------------

interface VitestAssertionResult {
  fullName: string;
  status: "passed" | "failed";
  failureMessages: string[];
}

interface VitestTestResult {
  testFilePath: string;
  assertionResults: VitestAssertionResult[];
}

interface VitestJsonOutput {
  testResults: VitestTestResult[];
  numPassedTests: number;
  numFailedTests: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip any absolute path prefix from `testFilePath` so the result is a
 * relative path that does not start with "/".
 *
 * Strategy: if the path starts with process.cwd(), strip that prefix
 * (plus any trailing separator). Otherwise, strip any leading "/".
 */
function toRelativePath(testFilePath: string): string {
  const cwd = process.cwd();
  if (testFilePath.startsWith(cwd)) {
    const relative = testFilePath.slice(cwd.length);
    // Strip any leading slash left after removing cwd
    return relative.replace(/^[\\/]+/, "");
  }
  // Fallback: strip any leading slash
  return testFilePath.replace(/^[\\/]+/, "");
}

/**
 * Derive a human-readable description from a test's `fullName`.
 *
 * Splits on the LAST occurrence of " > " to separate describe context from
 * test name. Produces: "In [describe]: [test]".
 *
 * If there is no " > " separator, treats the whole string as the test name
 * with an empty describe context: "In : [fullName]".
 */
function deriveDescription(fullName: string): string {
  const separator = " > ";
  const lastIdx = fullName.lastIndexOf(separator);

  if (lastIdx === -1) {
    return `In : ${fullName}`;
  }

  const describe = fullName.slice(0, lastIdx);
  const test = fullName.slice(lastIdx + separator.length);
  return `In ${describe}: ${test}`;
}

/**
 * Parse vitest JSON output from stdout. Returns null if parsing fails.
 */
function parseVitestJson(stdout: string): VitestJsonOutput | null {
  try {
    return JSON.parse(stdout) as VitestJsonOutput;
  } catch {
    return null;
  }
}

/**
 * Extract all `FailureInfo` objects from a parsed vitest JSON output.
 * Only returns assertion results with status "failed".
 */
function extractFailures(parsed: VitestJsonOutput): FailureInfo[] {
  const failures: FailureInfo[] = [];

  for (const fileResult of parsed.testResults) {
    for (const assertion of fileResult.assertionResults) {
      if (assertion.status === "failed") {
        failures.push({
          testFile: toRelativePath(fileResult.testFilePath),
          testName: assertion.fullName,
          description: deriveDescription(assertion.fullName),
        });
      }
    }
  }

  return failures;
}

/**
 * Build a fallback FailureInfo when the output cannot be parsed as structured JSON.
 * Truncates combined stdout/stderr to 2000 characters.
 */
function buildFallbackFailure(stdout: string, stderr: string): FailureInfo {
  const combined = [stdout, stderr].filter(Boolean).join("\n");
  const truncated = combined.length > 2000 ? combined.slice(0, 2000) + "..." : combined;
  return {
    testFile: "unknown",
    testName: "integration test suite",
    description: truncated || "Integration tests failed with no output",
  };
}

// ---------------------------------------------------------------------------
// Phase executor
// ---------------------------------------------------------------------------

/**
 * Execute the INTEG_TEST phase: run the configured integ test command, parse
 * its output, and return the corresponding transition event.
 *
 * Returns `IntegPassed` immediately if no integ test command is configured.
 * Returns `IntegPassed` only when the command exits 0 AND no failed tests are
 * found in parsed output. Otherwise returns `IntegFailed` with all collected
 * `FailureInfo` objects.
 */
export async function execIntegTest(
  _state: LoopState,
  shell: ShellAdapter,
  repoRoot: string,
  config: DevLoopConfig
): Promise<TransitionEvent> {
  // Skip integ tests if no command is configured.
  if (!config.integTestCommand) {
    return { type: "IntegPassed" };
  }

  const result = await shell.exec(config.integTestCommand, repoRoot);

  const parsed = parseVitestJson(result.stdout);

  if (result.exitCode === 0 && (parsed === null || parsed.numFailedTests === 0)) {
    return { type: "IntegPassed" };
  }

  // Collect structured failures if we can parse them, otherwise use fallback.
  let failures: FailureInfo[];
  if (parsed !== null) {
    failures = extractFailures(parsed);
    // If structured parse returned no individual failures but command failed,
    // add a fallback entry so INTEG_FIX has something to work with.
    if (failures.length === 0) {
      failures = [buildFallbackFailure(result.stdout, result.stderr)];
    }
  } else {
    failures = [buildFallbackFailure(result.stdout, result.stderr)];
  }

  return { type: "IntegFailed", failures };
}
