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
 * Builds RunnerDeps from environment and config.
 */
async function buildDeps(repoRoot: string): Promise<RunnerDeps> {
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
  };
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleStartLoop(args: Record<string, unknown>): Promise<string> {
  const repoRoot = getRepoRoot();
  const deps = await buildDeps(repoRoot);
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

async function handleResumeLoop(args: Record<string, unknown>): Promise<string> {
  const repoRoot = getRepoRoot();
  const deps = await buildDeps(repoRoot);

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

    try {
      let result: string;

      switch (name) {
        case "start_loop":
          result = await handleStartLoop(toolArgs);
          break;
        case "resume_loop":
          result = await handleResumeLoop(toolArgs);
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
