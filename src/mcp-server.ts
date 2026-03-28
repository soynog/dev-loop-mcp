/**
 * MCP server exposing the dev-loop state machine as three tools:
 *   - start_loop: Start a new development loop
 *   - resume_loop: Resume an interrupted loop
 *   - loop_status: Get current loop status
 *
 * Reads ANTHROPIC_API_KEY from environment.
 * Reads DEV_LOOP_ROOT from environment (defaults to process.cwd()).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import Anthropic from "@anthropic-ai/sdk";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as crypto from "node:crypto";
import type { AnthropicClientLike } from "./ai-worker.js";

import { loadConfig } from "./config.js";
import { loadState, saveState } from "./persistence.js";
import { runLoop } from "./runner.js";
import { RealShellAdapter } from "./shell.js";
import { AnthropicDevWorker } from "./ai-worker.js";
import type { LoopState, Task, RunnerDeps } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the project root to operate in.
 * Uses DEV_LOOP_ROOT env var if set, otherwise falls back to process.cwd().
 */
function getRepoRoot(): string {
  return process.env["DEV_LOOP_ROOT"] ?? process.cwd();
}

/**
 * Creates a new LoopState for a fresh run.
 */
function createInitialState(
  branch: string,
  tasks: Task[],
  startPhase: LoopState["phase"]
): LoopState {
  const now = new Date().toISOString();
  return {
    version: 1,
    runId: crypto.randomUUID(),
    branch,
    phase: startPhase,
    tasks,
    currentTaskIdx: 0,
    integFixIteration: 0,
    startedAt: now,
    updatedAt: now,
  };
}

/**
 * Formats a LoopState into a human-readable status string.
 */
function formatStatus(state: LoopState): string {
  const lines: string[] = [
    `Run ID: ${state.runId}`,
    `Branch: ${state.branch}`,
    `Phase: ${state.phase}`,
    `Started: ${state.startedAt}`,
    `Updated: ${state.updatedAt}`,
  ];

  if (state.tasks.length > 0) {
    lines.push(`\nTasks (${state.currentTaskIdx + 1}/${state.tasks.length}):`);
    for (const task of state.tasks) {
      lines.push(`  [${task.status}] ${task.title}`);
    }
  }

  if (state.failureReason) {
    lines.push(`\nFailure: ${state.failureReason}`);
  }

  if (state.prUrl) {
    lines.push(`\nPR: ${state.prUrl}`);
  }

  return lines.join("\n");
}

/**
 * Loads KEY=VALUE pairs from a .env file into process.env.
 * Only sets variables that are not already present in the environment.
 * Silently skips if the file does not exist or cannot be read.
 */
function loadDotEnv(repoRoot: string): void {
  const envPath = nodePath.join(repoRoot, ".env");
  let raw: string;
  try {
    raw = fs.readFileSync(envPath, "utf-8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
}

/**
 * Builds RunnerDeps from environment and config.
 * `log` is optional — when provided the runner emits progress lines at each
 * phase boundary (e.g. piped to server.sendLoggingMessage for MCP clients).
 */
async function buildDeps(
  repoRoot: string,
  log?: (message: string) => void
): Promise<RunnerDeps> {
  loadDotEnv(repoRoot);
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable is required");
  }

  const config = await loadConfig(repoRoot);
  const client = new Anthropic({ apiKey }) as unknown as AnthropicClientLike;
  const shell = new RealShellAdapter();
  const modelId = config.model ?? "claude-sonnet-4-6";
  const aiWorker = new AnthropicDevWorker(client, modelId, shell);

  return {
    shell,
    aiWorker,
    stateFilePath: nodePath.join(repoRoot, ".loop-state.json"),
    repoRoot,
    config,
    log,
  };
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleStartLoop(args: Record<string, unknown>, log: (msg: string) => void): Promise<string> {
  const repoRoot = getRepoRoot();
  const deps = await buildDeps(repoRoot, log);
  const config = await loadConfig(repoRoot);
  const branchPrefix = config.branchPrefix ?? "claude/";

  const description = args["description"] as string | undefined;
  const tasksArg = args["tasks"] as Task[] | undefined;
  const branchArg = args["branch"] as string | undefined;

  if (!description && !tasksArg) {
    throw new Error("Either 'description' or 'tasks' must be provided");
  }

  // Generate branch name from description or use provided branch
  let branch: string;
  if (branchArg) {
    branch = branchArg;
  } else if (description) {
    const slug = description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    branch = `${branchPrefix}${slug}`;
  } else {
    branch = `${branchPrefix}loop-${Date.now()}`;
  }

  // Determine starting phase and pre-loaded tasks
  let initialTasks: Task[] = [];
  let startPhase: LoopState["phase"] = "INIT";

  if (tasksArg && tasksArg.length > 0) {
    // Pre-decomposed tasks — skip INIT's DECOMPOSE by putting tasks in state
    initialTasks = tasksArg.map((t, i) => ({
      ...t,
      id: t.id ?? i + 1,
      status: "pending" as const,
      iterations: 0,
    }));
    startPhase = "INIT";
  } else {
    // description provided — AI will decompose, start with branch name as input
    startPhase = "INIT";
  }

  const initialState = createInitialState(branch, initialTasks, startPhase);
  await saveState(deps.stateFilePath, initialState);

  const finalState = await runLoop(initialState, deps);

  if (finalState.phase === "DONE") {
    return `Loop completed successfully.\nPR: ${finalState.prUrl ?? "unknown"}`;
  } else {
    return `Loop failed.\nReason: ${finalState.failureReason ?? "unknown"}`;
  }
}

async function handleStartDebugLoop(args: Record<string, unknown>, log: (msg: string) => void): Promise<string> {
  const repoRoot = getRepoRoot();
  const deps = await buildDeps(repoRoot, log);
  const config = await loadConfig(repoRoot);
  const branchPrefix = config.branchPrefix ?? "claude/";

  const symptom = args["symptom"] as string | undefined;
  if (!symptom) {
    throw new Error("'symptom' is required");
  }

  const contextFilePaths = (args["context_files"] as string[] | undefined) ?? [];

  // Read any context files the caller specified (best-effort — warn on missing).
  const contextFiles: Record<string, string> = {};
  for (const relPath of contextFilePaths) {
    const absPath = nodePath.join(repoRoot, relPath);
    try {
      contextFiles[relPath] = fs.readFileSync(absPath, "utf-8");
    } catch (err) {
      console.warn(
        `start_debug_loop: could not read context file ${relPath}: ${(err as Error).message}`
      );
    }
  }

  // DIAGNOSE: AI reads symptom + context → ranked hypothesis tasks.
  const ts = () => new Date().toTimeString().slice(0, 8);
  log(`[${ts()}] DIAGNOSE: "${symptom}"`);
  const tasks = await deps.aiWorker.diagnose(symptom, contextFiles);
  log(`[${ts()}]   diagnosed ${tasks.length} hypotheses: ${tasks.map((t) => t.title).join(", ")}`);

  // Branch name derived from symptom, under a "debug/" sub-prefix.
  const slug = symptom
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const branch = `${branchPrefix}debug/${slug}`;

  // Preserve the symptom so generatePrBody can write a diagnosis-aware PR body.
  const initialState: LoopState = {
    ...createInitialState(branch, tasks, "INIT"),
    diagnosisContext: symptom,
  };

  await saveState(deps.stateFilePath, initialState);
  const finalState = await runLoop(initialState, deps);

  if (finalState.phase === "DONE") {
    return `Debug loop completed successfully.\nPR: ${finalState.prUrl ?? "unknown"}`;
  } else {
    return `Debug loop failed.\nReason: ${finalState.failureReason ?? "unknown"}`;
  }
}

async function handleResumeLoop(args: Record<string, unknown>, log: (msg: string) => void): Promise<string> {
  const repoRoot = getRepoRoot();
  const deps = await buildDeps(repoRoot, log);

  const state = await loadState(deps.stateFilePath);
  if (!state) {
    throw new Error("No loop state found. Run start_loop first.");
  }

  if (state.phase === "DONE" || state.phase === "FAILED") {
    return `Loop already in terminal state: ${state.phase}\n${formatStatus(state)}`;
  }

  const finalState = await runLoop(state, deps);

  if (finalState.phase === "DONE") {
    return `Loop completed successfully.\nPR: ${finalState.prUrl ?? "unknown"}`;
  } else {
    return `Loop failed.\nReason: ${finalState.failureReason ?? "unknown"}`;
  }
}

async function handleLoopStatus(): Promise<string> {
  const repoRoot = getRepoRoot();
  const stateFilePath = nodePath.join(repoRoot, ".loop-state.json");

  const state = await loadState(stateFilePath);
  if (!state) {
    return "No active loop found. Use start_loop to begin.";
  }

  return formatStatus(state);
}

// ---------------------------------------------------------------------------
// MCP server setup
// ---------------------------------------------------------------------------

/** Tool definitions exposed by this MCP server. */
const TOOLS = [
  {
    name: "start_loop",
    description:
      "Start a new AI-driven TDD development loop. Provide either a description " +
      "(the AI will decompose it into tasks) or a pre-defined tasks array. " +
      "Runs the full loop: INIT → DECOMPOSE → TDD_LOOP → BUILD → DEPLOY → " +
      "INTEG_TEST → QUALITY_REVIEW → CLEAN_TREE_CHECK → PUSH_AND_PR.",
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description:
            "Natural language description of the work to be done. " +
            "The AI will decompose this into tasks.",
        },
        tasks: {
          type: "array",
          description:
            "Pre-decomposed task list. If provided, skips the DECOMPOSE phase.",
          items: {
            type: "object",
            properties: {
              id: { type: "number" },
              title: { type: "string" },
              scope: { type: "string" },
              acceptance: { type: "string" },
            },
            required: ["title", "scope", "acceptance"],
          },
        },
        branch: {
          type: "string",
          description:
            "Git branch name. If not provided, one is generated from the description.",
        },
      },
    },
  },
  {
    name: "start_debug_loop",
    description:
      "Start an AI-driven debug loop from a symptom description. " +
      "Phase 1 — DIAGNOSE: the AI reads the specified context files and generates a " +
      "ranked list of root-cause hypotheses as TDD tasks (most likely first). " +
      "Phase 2 onwards: the standard TDD pipeline runs per hypothesis task — " +
      "failing tests encode each hypothesis, then implementation fixes it. " +
      "Ends with a PR whose body contains a full diagnosis writeup.",
    inputSchema: {
      type: "object",
      properties: {
        symptom: {
          type: "string",
          description:
            "Natural-language description of the observed bug or failure " +
            "(e.g. 'read_website returns failure on most real URLs').",
        },
        context_files: {
          type: "array",
          description:
            "Optional list of relative file paths to read and include as context " +
            "for the diagnosis step.",
          items: { type: "string" },
        },
      },
      required: ["symptom"],
    },
  },
  {
    name: "resume_loop",
    description:
      "Resume an interrupted development loop from the last saved state. " +
      "Reads .loop-state.json from the project root and continues from the current phase.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "loop_status",
    description:
      "Get the current status of the development loop. " +
      "Returns the phase, branch, task list, and any failure/PR information.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

/**
 * Creates and starts the MCP server on stdio transport.
 */
export async function startMcpServer(): Promise<void> {
  const server = new Server(
    {
      name: "dev-loop-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        logging: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const toolArgs = (args ?? {}) as Record<string, unknown>;

    // Log callback — sends MCP logging notifications to the client so progress
    // is visible in Claude Code (or any MCP client that displays log messages).
    const log = (message: string) => {
      void server.sendLoggingMessage({ level: "info", data: message });
    };

    try {
      let result: string;

      switch (name) {
        case "start_loop":
          result = await handleStartLoop(toolArgs, log);
          break;
        case "start_debug_loop":
          result = await handleStartDebugLoop(toolArgs, log);
          break;
        case "resume_loop":
          result = await handleResumeLoop(toolArgs, log);
          break;
        case "loop_status":
          result = await handleLoopStatus();
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [{ type: "text", text: result }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("dev-loop-mcp server started");
}
