/**
 * State persistence for the dev-loop runner.
 *
 * Provides atomic save/load of LoopState to a JSON file on disk.
 * Atomicity is achieved by writing to a `.tmp` file then renaming it —
 * so a mid-write crash never corrupts the canonical state file.
 */
import * as fs from "node:fs/promises";
import type { LoopState } from "./types.js";

// ---------------------------------------------------------------------------
// Custom error
// ---------------------------------------------------------------------------

/** Thrown by loadState when the file is unreadable or fails schema validation. */
export class StateLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateLoadError";
    // Maintain correct prototype chain in compiled-down ES5 targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Writes state to disk atomically.
 *
 * Serialises the state to JSON, writes it to `<filePath>.tmp`, then renames
 * that file to `filePath`. An interrupted write leaves the original file
 * (if any) intact.
 */
export async function saveState(
  filePath: string,
  state: LoopState
): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  const json = JSON.stringify(state, null, 2);

  await fs.writeFile(tmpPath, json, "utf-8");
  // fs.rename is atomic on POSIX filesystems — replaces the destination
  // in a single syscall so no reader can observe a half-written file.
  await fs.rename(tmpPath, filePath);
  console.log(`saveState: wrote state to ${filePath}`);
}

/**
 * Loads state from disk, returning null if the file is absent.
 *
 * Returns null for ENOENT so callers can treat a missing state file as a
 * fresh run. All other problems (malformed JSON, wrong schema version) throw
 * StateLoadError so callers can surface them to the user.
 */
export async function loadState(filePath: string): Promise<LoopState | null> {
  let raw: string;

  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if (isEnoent(err)) {
      return null;
    }
    throw new StateLoadError(filePath);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StateLoadError(filePath);
  }

  const state = parsed as LoopState;
  if (state.version !== 1) {
    throw new StateLoadError(filePath);
  }

  console.log(`loadState: loaded state from ${filePath} (phase=${state.phase})`);
  return state;
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
