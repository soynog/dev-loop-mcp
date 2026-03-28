/**
 * Configuration loader for the dev-loop MCP server.
 *
 * Reads `dev-loop.config.json` from the project root directory.
 * Returns sensible defaults if the file is absent so the loop works
 * out-of-the-box for standard Node.js projects.
 */
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import type { DevLoopConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Returns a DevLoopConfig with all default values.
 * Used as the base when merging a partial config file.
 */
export function defaultConfig(): DevLoopConfig {
  return {
    buildCommand: "npm run build",
    testCommand: "npm test",
    deployCommand: undefined,
    integTestCommand: undefined,
    branchPrefix: "claude/",
    model: "claude-sonnet-4-6",
  };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Reads `dev-loop.config.json` from `rootDir` and merges it with defaults.
 *
 * Returns defaults if the file does not exist. Throws if the file exists but
 * contains invalid JSON.
 */
export async function loadConfig(rootDir: string): Promise<DevLoopConfig> {
  const configPath = nodePath.join(rootDir, "dev-loop.config.json");

  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf-8");
  } catch (err) {
    if (isEnoent(err)) {
      // No config file — use defaults.
      return defaultConfig();
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `dev-loop.config.json at ${configPath} contains invalid JSON: ${(err as Error).message}`
    );
  }

  // Merge parsed values over defaults so missing keys fall back gracefully.
  return {
    ...defaultConfig(),
    ...(parsed as Partial<DevLoopConfig>),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Narrows an unknown catch value to an ENOENT filesystem error. */
function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}
