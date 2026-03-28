/**
 * MCP server exposing the dev-loop state machine as four tools:
 *   - start_loop:       Create a new loop and get the first instruction
 *   - start_debug_loop: Create a debug loop and get the DIAGNOSE instruction
 *   - advance_loop:     Report what you just did and get the next instruction
 *   - loop_status:      Get current phase / task status
 *
 * The server is a pure state machine — it never calls the Anthropic API.
 * All AI work (decomposition, TDD, quality review, etc.) is performed by
 * the calling model (Claude Code) following the instructions returned here.
 *
 * Reads DEV_LOOP_ROOT from environment (defaults to process.cwd()).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as nodePath from "node:path";
import * as crypto from "node:crypto";

import { loadConfig } from "./config.js";
import { loadState, saveState } from "./persistence.js";
import { transition } from "./state-machine.js";
import { generateInstruction } from "./instructions.js";
import { parseEvent } from "./event-parser.js";
import type { LoopState, Task } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRepoRoot(): string {
  return process.env["DEV_LOOP_ROOT"] ?? process.cwd();
}

function makeStateFilePath(repoRoot: string): string {
  return nodePath.join(repoRoot, ".loop-state.json");
}

function createInitialState(
  branch: string,
  tasks: Task[],
  diagnosisContext?: string
): LoopState {
  const now = new Date().toISOString();
  return {
    version: 1,
    runId: crypto.randomUUID(),
    branch,
    phase: "INIT",
    tasks,
    currentTaskIdx: 0,
    integFixIteration: 0,
    startedAt: now,
    updatedAt: now,
    ...(diagnosisContext ? { diagnosisContext } : {}),
  };
}

function formatStatus(state: LoopState): string {
  const lines: string[] = [
    `Run ID: ${state.runId}`,
    `Branch: ${state.branch}`,
    `Phase:  ${state.phase}`,
    `Started: ${state.startedAt}`,
    `Updated: ${state.updatedAt}`,
  ];

  if (state.tasks.length > 0) {
    lines.push(`\nTasks (${state.currentTaskIdx + 1}/${state.tasks.length}):`);
    for (const task of state.tasks) {
      lines.push(`  [${task.status}] ${task.title}`);
    }
  }

  if (state.failureReason) lines.push(`\nFailure: ${state.failureReason}`);
  if (state.prUrl) lines.push(`\nPR: ${state.prUrl}`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleStartLoop(args: Record<string, unknown>): Promise<string> {
  const repoRoot = getRepoRoot();
  const config = await loadConfig(repoRoot);
  const branchPrefix = config.branchPrefix ?? "claude/";

  const description = args["description"] as string | undefined;
  const tasksArg = args["tasks"] as Task[] | undefined;
  const branchArg = args["branch"] as string | undefined;

  if (!description && !tasksArg) {
    throw new Error("Either 'description' or 'tasks' must be provided");
  }

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

  const initialTasks: Task[] = tasksArg
    ? tasksArg.map((t, i) => ({
        ...t,
        id: t.id ?? i + 1,
        status: "pending" as const,
        iterations: 0,
      }))
    : [];

  const state = createInitialState(branch, initialTasks);
  await saveState(makeStateFilePath(repoRoot), state);

  return generateInstruction(state, config);
}

async function handleStartDebugLoop(args: Record<string, unknown>): Promise<string> {
  const repoRoot = getRepoRoot();
  const config = await loadConfig(repoRoot);
  const branchPrefix = config.branchPrefix ?? "claude/";

  const symptom = args["symptom"] as string | undefined;
  if (!symptom) throw new Error("'symptom' is required");

  const slug = symptom
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const branch = `${branchPrefix}debug/${slug}`;

  // No tasks yet — Claude Code will generate them during DECOMPOSE (with diagnosisContext
  // signalling that it should diagnose root causes rather than decompose a feature).
  const state = createInitialState(branch, [], symptom);
  await saveState(makeStateFilePath(repoRoot), state);

  return generateInstruction(state, config);
}

async function handleAdvanceLoop(args: Record<string, unknown>): Promise<string> {
  const repoRoot = getRepoRoot();
  const stateFilePath = makeStateFilePath(repoRoot);

  const state = await loadState(stateFilePath);
  if (!state) throw new Error("No active loop found. Call start_loop or start_debug_loop first.");

  if (state.phase === "DONE" || state.phase === "FAILED") {
    return generateInstruction(state, await loadConfig(repoRoot));
  }

  const event = parseEvent(args);
  const nextState = transition(state, event);
  await saveState(stateFilePath, nextState);

  const config = await loadConfig(repoRoot);
  return generateInstruction(nextState, config);
}

async function handleLoopStatus(): Promise<string> {
  const repoRoot = getRepoRoot();
  const state = await loadState(makeStateFilePath(repoRoot));
  if (!state) return "No active loop found. Use start_loop to begin.";
  return formatStatus(state);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "start_loop",
    description:
      "Start a new TDD development loop. Returns an instruction telling you " +
      "what to do first. Keep calling advance_loop after each step until the " +
      "loop reaches DONE or FAILED. " +
      "Phases: INIT → DECOMPOSE → TDD_LOOP → BUILD → DEPLOY → " +
      "INTEG_TEST → INTEG_FIX → QUALITY_REVIEW → CLEAN_TREE_CHECK → PUSH_AND_PR.",
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "Natural language description of the work to be done.",
        },
        tasks: {
          type: "array",
          description: "Pre-decomposed task list. If provided, skips DECOMPOSE.",
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
          description: "Git branch name. Generated from description if omitted.",
        },
      },
    },
  },
  {
    name: "start_debug_loop",
    description:
      "Start a debug loop from a symptom description. Returns an instruction " +
      "telling you to diagnose root causes as ranked TDD tasks, then proceeds " +
      "through the standard TDD pipeline. The PR body will include a diagnosis writeup.",
    inputSchema: {
      type: "object",
      properties: {
        symptom: {
          type: "string",
          description: "Natural-language description of the observed bug or failure.",
        },
      },
      required: ["symptom"],
    },
  },
  {
    name: "advance_loop",
    description:
      "Report the outcome of the last instruction and get the next one. " +
      "Call this after completing each phase step. The loop persists state between calls.",
    inputSchema: {
      type: "object",
      properties: {
        event: {
          type: "string",
          description:
            "The outcome event. One of: BranchCreated, TasksDecomposed, TaskDone, " +
            "TaskFailed, BuildPassed, BuildFailed, DeployPassed, DeployFailed, " +
            "IntegPassed, IntegFailed, IntegFixPassed, IntegFixFailed, " +
            "QualityDone, TreeClean, PrCreated.",
        },
        tasks: {
          type: "array",
          description: "For TasksDecomposed: the decomposed or diagnosed task list.",
          items: { type: "object" },
        },
        failureReason: {
          type: "string",
          description: "For TaskFailed: why the task could not be completed.",
        },
        stderr: {
          type: "string",
          description: "For BuildFailed or DeployFailed: the error output.",
        },
        failures: {
          type: "array",
          description: "For IntegFailed: array of {testFile, testName, description}.",
          items: { type: "object" },
        },
        prUrl: {
          type: "string",
          description: "For PrCreated: the URL of the opened pull request.",
        },
      },
      required: ["event"],
    },
  },
  {
    name: "loop_status",
    description:
      "Get the current status of the loop: phase, branch, task list, failure reason, or PR URL.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

export async function startMcpServer(): Promise<void> {
  const server = new Server(
    { name: "dev-loop-mcp", version: "0.2.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const toolArgs = (args ?? {}) as Record<string, unknown>;

    try {
      let result: string;
      switch (name) {
        case "start_loop":       result = await handleStartLoop(toolArgs);      break;
        case "start_debug_loop": result = await handleStartDebugLoop(toolArgs); break;
        case "advance_loop":     result = await handleAdvanceLoop(toolArgs);    break;
        case "loop_status":      result = await handleLoopStatus();             break;
        default: throw new Error(`Unknown tool: ${name}`);
      }
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("dev-loop-mcp server started");
}
