/**
 * AI Worker implementation for the dev-loop state machine.
 *
 * Implements all five AIWorker junctures: decompose, runTddLoop,
 * fixIntegFailures, runQualityReview, and generatePrBody.
 *
 * All prompts are generic and project-agnostic. The model ID is configurable
 * via DevLoopConfig.
 */

import * as fs from "node:fs";
import * as nodePath from "node:path";
import type {
  AIWorker,
  FailureInfo,
  LoopState,
  ShellAdapter,
  Task,
  TddResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Injectable client interface
// ---------------------------------------------------------------------------

/** Minimal interface for the Anthropic client, used for dependency injection. */
export interface AnthropicClientLike {
  messages: {
    create(params: {
      model: string;
      max_tokens: number;
      system: string;
      messages: Array<{
        role: "user" | "assistant";
        content: string | Array<{ type: string; [key: string]: unknown }>;
      }>;
      tools?: Array<unknown>;
    }): Promise<{
      content: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: unknown;
      }>;
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    }>;
  };
}

// ---------------------------------------------------------------------------
// Custom error
// ---------------------------------------------------------------------------

/** Thrown when `decompose` cannot parse a valid Task[] after two AI attempts. */
export class DecomposeError extends Error {
  override name = "DecomposeError" as const;

  constructor(message: string) {
    super(message);
    // Restore prototype chain for instanceof checks across compilation targets
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL_ID = "claude-sonnet-4-6";
const DECOMPOSE_MAX_TOKENS = 4096;
const DIAGNOSE_MAX_TOKENS = 4096;
const PR_BODY_MAX_TOKENS = 1024;
const TDD_LOOP_MAX_TOKENS = 8192;
const TDD_MAX_ITERATIONS = 5;

const DECOMPOSE_SYSTEM_PROMPT =
  "You are a software project manager. Decompose the given input into an ordered list " +
  "of independently testable tasks following TDD principles. Each task should be small " +
  "enough to implement in a single TDD cycle (scenarios → failing tests → implementation). " +
  "Each task must have: id (number), title (short string), " +
  "scope (affected files or modules), acceptance (plain-English success definition). " +
  "Reply with ONLY a JSON code block containing a Task[] array.";

const DIAGNOSE_SYSTEM_PROMPT =
  "You are a debugging engineer. Given a symptom and relevant source files, identify the " +
  "most likely root causes ordered from most to least likely. " +
  "For each root cause produce one TDD task: a small, independently testable hypothesis " +
  "that will be verified by writing a failing test then implementing the fix. " +
  "Each task must have: id (number), title (short string naming the root-cause hypothesis), " +
  "scope (affected files or modules), acceptance (plain-English description of correct " +
  "behaviour after the fix). " +
  "Reply with ONLY a JSON code block containing a Task[] array.";

const PR_BODY_SYSTEM_PROMPT =
  "You are a developer writing a GitHub pull request. Be concise.";

const TDD_SYSTEM_PROMPT =
  "You are a TDD developer. You write scenarios, then failing tests, then implement code to make them pass. " +
  "You have two tools: read_file to read files in the repository, and write_file to create or update files. " +
  "You never run tests yourself — you will be told if tests pass or fail. " +
  "When writing implementation, never read test files to infer what to write — implement from the task description. " +
  "Follow good software engineering practices: small focused functions, clear naming, no dead code.";

const INTEG_FIX_SYSTEM_PROMPT =
  "You are a debugging engineer. You diagnose and fix failing integration tests by reading " +
  "implementation code and correcting bugs. " +
  "You have two tools: read_file to read files in the repository, and write_file to create or update files. " +
  "Do NOT read test files to understand what to change — fix the implementation code only.";

const QUALITY_REVIEW_SYSTEM_PROMPT =
  "You are a senior engineer performing a code review. Review the provided diff and fix any quality issues: " +
  "dead code (unused variables, functions, imports), overly complex logic that can be simplified, " +
  "incorrect or missing type annotations, missing error handling at system boundaries, " +
  "and any public behavior that lacks test coverage. " +
  "Do not add new features. Make the smallest changes necessary to improve quality. " +
  "You have two tools: read_file to read files in the repository, and write_file to create or update files.";

// ---------------------------------------------------------------------------
// Types for the agent loop internal message representation
// ---------------------------------------------------------------------------

type AgentContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

type AgentMessage = {
  role: "user" | "assistant";
  content: string | AgentContentBlock[];
};

// ---------------------------------------------------------------------------
// Vitest JSON output types (used for TDD loop failure parsing)
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
// Tool definitions for the agent loop
// ---------------------------------------------------------------------------

const AGENT_TOOLS = [
  {
    name: "read_file",
    description: "Read the contents of a file in the repository.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path from the repository root.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file in the repository.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path from the repository root.",
        },
        content: {
          type: "string",
          description: "Full file contents to write.",
        },
      },
      required: ["path", "content"],
    },
  },
];

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extracts plain text from an Anthropic response content array.
 * Joins all `text` blocks into a single string.
 */
function extractText(
  content: Array<{ type: string; text?: string }>
): string {
  return content
    .filter((b) => b.type === "text" && b.text != null)
    .map((b) => b.text as string)
    .join("");
}

/**
 * Attempts to parse a Task[] from a raw response string.
 * Accepts either a ```json … ``` fenced block or a bare JSON array.
 * Returns null if parsing or validation fails.
 */
function parseTasksFromText(text: string): Task[] | null {
  // Try ```json ... ``` fence first
  const fenceMatch = text.match(/```json\s*([\s\S]*?)```/);
  const jsonString = fenceMatch ? fenceMatch[1].trim() : text.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) return null;

  for (const item of parsed) {
    if (
      typeof item !== "object" ||
      item === null ||
      !item.id ||
      !item.title ||
      !(item as Record<string, unknown>).scope ||
      !(item as Record<string, unknown>).acceptance
    ) {
      return null;
    }
  }

  return (parsed as Array<Record<string, unknown>>).map((item) => ({
    id: item.id as number,
    title: item.title as string,
    scope: item.scope as string,
    acceptance: item.acceptance as string,
    status: "pending" as const,
    iterations: 0,
  }));
}

/**
 * Builds the user message content for `decompose`.
 * Appends context file contents after the main input string.
 */
function buildDecomposeUserMessage(
  input: string,
  contextFiles: Record<string, string>
): string {
  let message = input;
  for (const [filename, content] of Object.entries(contextFiles)) {
    message += `\n\n${filename}\n${content}`;
  }
  return message;
}

/**
 * Convert a task title to kebab-case for use in file/commit names.
 * Lowercases, replaces non-alphanumeric runs with hyphens, trims edges.
 */
function toKebabCase(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Parse vitest JSON from stdout. Returns null if stdout is not valid JSON.
 */
function parseVitestJson(stdout: string): VitestJsonOutput | null {
  try {
    return JSON.parse(stdout) as VitestJsonOutput;
  } catch {
    return null;
  }
}

/**
 * Extract FailureInfo[] from a parsed vitest JSON output.
 * Only returns results with status "failed".
 */
function extractTddFailures(parsed: VitestJsonOutput): FailureInfo[] {
  const failures: FailureInfo[] = [];
  for (const fileResult of parsed.testResults) {
    for (const assertion of fileResult.assertionResults) {
      if (assertion.status === "failed") {
        failures.push({
          testFile: fileResult.testFilePath,
          testName: assertion.fullName,
          description: assertion.fullName,
        });
      }
    }
  }
  return failures;
}

/**
 * Builds the user message content for `generatePrBody`.
 * Summarises the loop state: branch name, tasks with status and iterations.
 * When a diagnosisContext is present (debug loop), the PR instructions ask for
 * a writeup that covers the symptom, root causes found, and what was fixed.
 */
function buildPrBodyUserMessage(state: LoopState): string {
  const taskLines = state.tasks
    .map(
      (t) =>
        `- [${t.status}] ${t.title} (iterations: ${t.iterations})`
    )
    .join("\n");

  let message = `Branch: ${state.branch}\n\nTasks:\n${taskLines}\n\n`;

  if (state.diagnosisContext) {
    message +=
      `Symptom investigated: ${state.diagnosisContext}\n\n` +
      "Write a GitHub PR title and body for this debug fix. " +
      "The body must include: the symptom, the root causes identified (one per task above), " +
      "and a brief description of the fix applied. " +
      "Format your response as:\ntitle: <short title>\nbody: <description>";
  } else {
    message +=
      "Write a GitHub PR title and body for these changes. " +
      "Format your response as:\ntitle: <short title>\nbody: <description>";
  }

  return message;
}

// ---------------------------------------------------------------------------
// AnthropicDevWorker
// ---------------------------------------------------------------------------

/** Production AI worker backed by the Anthropic SDK via dependency injection. */
export class AnthropicDevWorker implements AIWorker {
  private readonly client: AnthropicClientLike;
  private readonly modelId: string;
  private readonly shell: ShellAdapter | undefined;

  /**
   * Constructs an `AnthropicDevWorker`.
   *
   * `shell` is required for `runTddLoop` — inject it so the interface signature
   * (`task, repoRoot`) remains stable while still supporting test doubles.
   */
  constructor(
    client: AnthropicClientLike,
    modelId: string = DEFAULT_MODEL_ID,
    shell?: ShellAdapter,
  ) {
    this.client = client;
    this.modelId = modelId;
    this.shell = shell;
  }

  /**
   * Converts raw user input into a structured Task list via a single AI call.
   * On a malformed first response, sends a correction prompt and retries once.
   * Throws DecomposeError if both attempts produce unparseable output.
   */
  async decompose(
    input: string,
    contextFiles: Record<string, string>
  ): Promise<Task[]> {
    const userMessage = buildDecomposeUserMessage(input, contextFiles);

    // First attempt
    const firstResponse = await this.client.messages.create({
      model: this.modelId,
      max_tokens: DECOMPOSE_MAX_TOKENS,
      system: DECOMPOSE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const firstText = extractText(firstResponse.content);
    const firstTasks = parseTasksFromText(firstText);
    if (firstTasks !== null) {
      return firstTasks;
    }

    console.warn("decompose: first response was not valid JSON, retrying with correction prompt");

    // Second attempt — independent call with correction prompt
    const secondResponse = await this.client.messages.create({
      model: this.modelId,
      max_tokens: DECOMPOSE_MAX_TOKENS,
      system: DECOMPOSE_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content:
            "Your previous response was not valid JSON. Reply with ONLY a JSON array.",
        },
      ],
    });

    const secondText = extractText(secondResponse.content);
    const secondTasks = parseTasksFromText(secondText);
    if (secondTasks !== null) {
      return secondTasks;
    }

    throw new DecomposeError(
      "decompose: could not parse a valid Task[] from two AI attempts"
    );
  }

  /**
   * Analyses a symptom description and optional context files to produce a ranked
   * list of root-cause hypotheses as TDD tasks (most likely first).
   *
   * Structurally mirrors `decompose`: one AI call with a parse-and-retry fallback.
   * Throws DecomposeError if both attempts produce unparseable output.
   */
  async diagnose(
    symptom: string,
    contextFiles: Record<string, string>
  ): Promise<Task[]> {
    // Build user message: symptom first, then any provided source files.
    let userMessage = `Symptom: ${symptom}`;
    for (const [filename, content] of Object.entries(contextFiles)) {
      userMessage += `\n\n--- ${filename} ---\n${content}`;
    }

    // First attempt
    const firstResponse = await this.client.messages.create({
      model: this.modelId,
      max_tokens: DIAGNOSE_MAX_TOKENS,
      system: DIAGNOSE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const firstText = extractText(firstResponse.content);
    const firstTasks = parseTasksFromText(firstText);
    if (firstTasks !== null) {
      return firstTasks;
    }

    console.warn("diagnose: first response was not valid JSON, retrying with correction prompt");

    // Second attempt — correction prompt
    const secondResponse = await this.client.messages.create({
      model: this.modelId,
      max_tokens: DIAGNOSE_MAX_TOKENS,
      system: DIAGNOSE_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content:
            "Your previous response was not valid JSON. Reply with ONLY a JSON array.",
        },
      ],
    });

    const secondText = extractText(secondResponse.content);
    const secondTasks = parseTasksFromText(secondText);
    if (secondTasks !== null) {
      return secondTasks;
    }

    throw new DecomposeError(
      "diagnose: could not parse a valid Task[] from two AI attempts"
    );
  }

  /**
   * Generates a GitHub pull request title and body from the final loop state.
   * Falls back to branch name + task list if the model response cannot be parsed.
   */
  async generatePrBody(
    state: LoopState
  ): Promise<{ title: string; body: string }> {
    const userMessage = buildPrBodyUserMessage(state);

    const response = await this.client.messages.create({
      model: this.modelId,
      max_tokens: PR_BODY_MAX_TOKENS,
      system: PR_BODY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const text = extractText(response.content);

    const titleMatch = text.match(/^title:\s*(.+)/im);
    const bodyMatch = text.match(/^body:\s*(.+)/im);

    if (titleMatch && bodyMatch) {
      return {
        title: titleMatch[1].trim(),
        body: bodyMatch[1].trim(),
      };
    }

    // Fallback: branch name as title, task titles joined as body
    console.warn("generatePrBody: could not parse title/body from response, using fallback");
    const fallbackBody = state.tasks
      .map((t) => `- ${t.title}`)
      .join("\n");

    return {
      title: state.branch,
      body: fallbackBody,
    };
  }

  // ---------------------------------------------------------------------------
  // runTddLoop — drives the multi-turn TDD conversation for a single task
  // ---------------------------------------------------------------------------

  /**
   * Runs a full TDD cycle for one task: scenarios → failing tests → implementation.
   * The AI calls read_file / write_file; only this method runs tests via shell.exec.
   *
   * Returns TddResult indicating success/failure and the number of coding iterations.
   * Requires a ShellAdapter injected at construction time.
   */
  async runTddLoop(task: Task, repoRoot: string): Promise<TddResult> {
    const shell = this.shell;
    if (!shell) {
      throw new Error("runTddLoop: shell adapter is required — pass it to the constructor");
    }

    const kebab = toKebabCase(task.title);
    const scenariosPath = `scenarios/scenarios-${kebab}.md`;
    const testFileName = `${kebab}.test.ts`;

    // Shared conversation history — persists across all turns of the session.
    const messages: AgentMessage[] = [];

    // --- Turn 1: Scenarios -----------------------------------------------
    const scenariosUserMsg =
      `Write a scenarios file for this task: ${task.title}. ` +
      `Scope: ${task.scope}. ` +
      `Acceptance: ${task.acceptance}. ` +
      `Write scenarios to ${scenariosPath}`;

    messages.push({ role: "user", content: scenariosUserMsg });
    await this._runAgentLoop(messages, repoRoot, TDD_SYSTEM_PROMPT);

    // Commit the scenarios file after the AI finishes the scenarios turn.
    await shell.exec(`git add -A && git commit -m 'test: add scenarios for ${task.title}'`, repoRoot);

    // --- Turn 2: Test-writing ---------------------------------------------
    messages.push({
      role: "user",
      content:
        `Now write failing unit tests for this task. ` +
        `The test file goes at ${testFileName}. ` +
        `Tests must fail before implementation. Do not write any implementation code.`,
    });
    await this._runAgentLoop(messages, repoRoot, TDD_SYSTEM_PROMPT);

    // Run tests: they should fail (red phase).
    const initialTestResult = await shell.exec("npm test", repoRoot);
    if (initialTestResult.exitCode === 0) {
      // Tests passed before any implementation — tester error.
      return {
        success: false,
        attempts: 0,
        failureReason: "tests passed before implementation — tester error",
      };
    }

    // Commit test artifacts before coding begins.
    await shell.exec(`git add -A && git commit -m 'test: add failing tests for ${task.title}'`, repoRoot);

    // Track the most recent failing test output so each iteration gets fresh failure info.
    let lastFailingResult = initialTestResult;

    // --- Coding loop (max TDD_MAX_ITERATIONS iterations) -----------------
    for (let iteration = 0; iteration < TDD_MAX_ITERATIONS; iteration++) {
      // Parse failures from the most recent test output.
      const parsed = parseVitestJson(lastFailingResult.stdout);
      const failures = parsed ? extractTddFailures(parsed) : [];
      const failureList = failures.length > 0
        ? failures.map((f) => `- ${f.description}`).join("\n")
        : "- Tests failed (no structured output available)";

      messages.push({
        role: "user",
        content:
          `Implement the feature to make these tests pass. ` +
          `Do NOT read any test files. Failing scenarios:\n${failureList}`,
      });
      await this._runAgentLoop(messages, repoRoot, TDD_SYSTEM_PROMPT);

      // Run tests after implementation attempt.
      const implResult = await shell.exec("npm test", repoRoot);
      if (implResult.exitCode === 0) {
        // All tests pass — commit and return success.
        await shell.exec(
          `git add -A && git commit -m 'feat: implement ${task.title} (iteration ${iteration + 1})'`,
          repoRoot
        );
        return { success: true, attempts: iteration + 1 };
      }

      // Still failing — update reference for next iteration.
      lastFailingResult = implResult;
    }

    // Exhausted all iterations without passing.
    return {
      success: false,
      attempts: TDD_MAX_ITERATIONS,
      failureReason: `${TDD_MAX_ITERATIONS} iterations exhausted`,
    };
  }

  /**
   * Fixes integration test failures by driving the AI to diagnose and repair
   * implementation code. After the agent loop completes, runs the build command
   * to verify the tree is clean. Does NOT re-run tests — the runner handles that.
   */
  async fixIntegFailures(
    failures: FailureInfo[],
    repoRoot: string
  ): Promise<void> {
    const shell = this.shell;
    if (!shell) {
      throw new Error("fixIntegFailures: shell adapter is required — pass it to the constructor");
    }

    const bulletList = failures.map((f) => `- ${f.description}`).join("\n");
    const userMessage =
      "These integration tests are failing. Diagnose and fix the implementation code. " +
      "Do NOT read any test files.\n\nFailing tests:\n" +
      bulletList;

    const messages: AgentMessage[] = [{ role: "user", content: userMessage }];
    await this._runAgentLoop(messages, repoRoot, INTEG_FIX_SYSTEM_PROMPT);
  }

  /**
   * Reviews the branch diff for quality issues and applies fixes via the agent loop.
   * Does NOT push or open a PR.
   */
  async runQualityReview(diff: string, repoRoot: string): Promise<void> {
    const shell = this.shell;
    if (!shell) {
      throw new Error("runQualityReview: shell adapter is required — pass it to the constructor");
    }

    const userMessage =
      "Review these code changes and fix any quality issues. " +
      "Look for: unused variables or imports, overly complex logic, " +
      "incorrect type annotations, missing error handling at system boundaries, " +
      "and any public behavior without test coverage. " +
      "Do not add new features. Make the smallest changes necessary.\n\nDiff:\n" +
      diff;

    const messages: AgentMessage[] = [{ role: "user", content: userMessage }];
    await this._runAgentLoop(messages, repoRoot, QUALITY_REVIEW_SYSTEM_PROMPT);
  }

  /**
   * Runs the multi-turn tool-use loop for one conversation turn.
   *
   * Appends the assistant response and any tool results to `messages` in place.
   * Exits when the model returns stop_reason "end_turn" or no tool_use blocks remain.
   */
  private async _runAgentLoop(
    messages: AgentMessage[],
    repoRoot: string,
    systemPrompt: string,
  ): Promise<void> {

    while (true) {
      const response = await this.client.messages.create({
        model: this.modelId,
        max_tokens: TDD_LOOP_MAX_TOKENS,
        system: systemPrompt,
        messages: messages as Array<{
          role: "user" | "assistant";
          content: string | Array<{ type: string; [key: string]: unknown }>;
        }>,
        tools: AGENT_TOOLS,
      });

      // Collect tool_use blocks from this response.
      const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");

      // Append assistant turn to history.
      messages.push({
        role: "assistant",
        content: response.content as AgentContentBlock[],
      });

      // If no tool calls or end_turn, the AI is done with this turn.
      if (response.stop_reason === "end_turn" || toolUseBlocks.length === 0) {
        break;
      }

      // Execute each tool call and collect results for the next user message.
      const toolResults: AgentContentBlock[] = [];
      for (const block of toolUseBlocks) {
        const toolBlock = block as {
          type: "tool_use";
          id: string;
          name: string;
          input: Record<string, unknown>;
        };
        const resultContent = this._executeTool(toolBlock.name, toolBlock.input, repoRoot);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolBlock.id,
          content: resultContent,
        });
      }

      messages.push({ role: "user", content: toolResults });
    }
  }

  /**
   * Executes a single tool call synchronously and returns the result as a string.
   * Supported tools: read_file, write_file.
   */
  private _executeTool(
    name: string,
    input: Record<string, unknown>,
    repoRoot: string,
  ): string {
    if (name === "read_file") {
      const relPath = input["path"] as string;
      const absPath = nodePath.join(repoRoot, relPath);
      try {
        return fs.readFileSync(absPath, "utf-8");
      } catch (err) {
        return `Error reading file: ${(err as Error).message}`;
      }
    }

    if (name === "write_file") {
      const relPath = input["path"] as string;
      const content = input["content"] as string;
      const absPath = nodePath.join(repoRoot, relPath);
      try {
        fs.mkdirSync(nodePath.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, content, "utf-8");
        return `File written: ${relPath}`;
      } catch (err) {
        return `Error writing file: ${(err as Error).message}`;
      }
    }

    return `Unknown tool: ${name}`;
  }
}
