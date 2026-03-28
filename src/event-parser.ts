/**
 * Parses a flat MCP tool-call arguments object into a typed TransitionEvent.
 *
 * `advance_loop` receives args like { event: "TaskDone" } or
 * { event: "TaskFailed", failureReason: "..." } and this module converts
 * them into the discriminated union that `transition()` expects.
 */

import type { TransitionEvent } from "./state-machine.js";

/**
 * Parse an `advance_loop` args object into a TransitionEvent.
 * Throws a descriptive Error if the event field is missing or unknown.
 */
export function parseEvent(args: Record<string, unknown>): TransitionEvent {
  if (!("event" in args) || args["event"] === undefined) {
    throw new Error("advance_loop: 'event' field is required");
  }

  if (typeof args["event"] !== "string") {
    throw new Error("advance_loop: 'event' must be a string");
  }

  const type = args["event"];

  switch (type) {
    case "BranchCreated":
      return { type: "BranchCreated" };

    case "TasksDecomposed":
      return { type: "TasksDecomposed", tasks: args["tasks"] as never };

    case "TaskDone":
      return { type: "TaskDone" };

    case "TaskFailed":
      return { type: "TaskFailed", failureReason: (args["failureReason"] as string) ?? "" };

    case "BuildPassed":
      return { type: "BuildPassed" };

    case "BuildFailed":
      return { type: "BuildFailed", stderr: (args["stderr"] as string) ?? "" };

    case "DeployPassed":
      return { type: "DeployPassed" };

    case "DeployFailed":
      return { type: "DeployFailed", stderr: (args["stderr"] as string) ?? "" };

    case "IntegPassed":
      return { type: "IntegPassed" };

    case "IntegFailed":
      return { type: "IntegFailed", failures: (args["failures"] as never) ?? [] };

    case "IntegFixPassed":
      return { type: "IntegFixPassed" };

    case "IntegFixFailed":
      return { type: "IntegFixFailed" };

    case "QualityDone":
      return { type: "QualityDone" };

    case "TreeClean":
      return { type: "TreeClean" };

    case "PrCreated":
      return { type: "PrCreated", prUrl: (args["prUrl"] as string) ?? "" };

    default:
      throw new Error(`advance_loop: unknown event "${type}"`);
  }
}
