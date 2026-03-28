# Handback Architecture Scenarios

The dev-loop MCP server should act as a pure state machine that returns
instructions to the calling AI (Claude Code). The calling AI executes the
work using its own tools (file reads/writes, bash, git) and reports back via
`advance_loop`. The server never calls the Anthropic API directly.

---

## Instruction generation

Each phase must produce an instruction string that tells Claude Code exactly
what to do and what `advance_loop` event to call when done.

### INIT
- Contains the branch name so Claude Code knows what branch to create
- Tells Claude Code to run `git checkout -b <branch>`
- Tells Claude Code to call `advance_loop` with event `BranchCreated`

### DECOMPOSE (feature loop)
- Makes clear what description to decompose (the branch name)
- Asks Claude Code to produce an ordered list of TDD tasks with id, title,
  scope, and acceptance fields
- Tells Claude Code to call `advance_loop` with event `TasksDecomposed` and
  the resulting tasks array

### DECOMPOSE (debug loop — diagnosisContext present)
- Makes the symptom prominent so Claude Code knows it is diagnosing a bug,
  not building a feature
- Asks for root-cause hypotheses ordered by likelihood, formatted as TDD tasks
- Tells Claude Code to call `advance_loop` with event `TasksDecomposed` and
  the hypothesis tasks array

### TDD_LOOP
- Identifies the current task by title, scope, and acceptance criteria
- Shows progress (e.g. "task 2 of 5") so Claude Code knows where it is
- Includes the configured `testCommand` so Claude Code runs the right command
- Describes the full TDD cycle: scenarios file → commit → failing tests →
  confirm red → commit → implement → run tests → commit on green
- Tells Claude Code to call `advance_loop` with `TaskDone` on success or
  `TaskFailed` (with a reason) after exhausting attempts

### BUILD
- Includes the configured `buildCommand`
- Tells Claude Code to call `advance_loop` with `BuildPassed` or `BuildFailed`

### DEPLOY (command configured)
- Includes the configured `deployCommand`
- Tells Claude Code to call `advance_loop` with `DeployPassed` or `DeployFailed`

### DEPLOY (no command configured)
- Tells Claude Code to skip this phase
- Tells Claude Code to call `advance_loop` with `DeployPassed`

### INTEG_TEST (command configured)
- Includes the configured `integTestCommand`
- Tells Claude Code to call `advance_loop` with `IntegPassed` or `IntegFailed`

### INTEG_TEST (no command configured)
- Tells Claude Code to skip this phase
- Tells Claude Code to call `advance_loop` with `IntegPassed`

### INTEG_FIX
- Lists the failing test descriptions so Claude Code knows what to fix
- Shows which attempt this is (e.g. "attempt 1 of 5")
- Instructs Claude Code NOT to read test files — fix implementation only
- Tells Claude Code to call `advance_loop` with `IntegFixPassed` or `IntegFixFailed`

### QUALITY_REVIEW
- Tells Claude Code to run `git diff main...HEAD` to get the diff
- Lists quality issues to look for (dead code, type errors, missing error
  handling, untested public behaviour)
- Tells Claude Code NOT to add new features
- Tells Claude Code to call `advance_loop` with `QualityDone`

### CLEAN_TREE_CHECK
- Tells Claude Code to run `git status --short`
- Instructs Claude Code to commit any uncommitted files before proceeding
- Tells Claude Code to call `advance_loop` with `TreeClean`

### PUSH_AND_PR
- Contains the branch name so Claude Code can push it
- Lists completed task titles so Claude Code can write an informative PR body
- Tells Claude Code to run `git push origin <branch>` then `gh pr create`
- Tells Claude Code to call `advance_loop` with `PrCreated` and the PR URL

### DONE (terminal)
- Contains the PR URL
- Indicates success clearly

### FAILED (terminal)
- Contains the failure reason
- Indicates failure clearly

---

## Event parsing

`advance_loop` receives a flat args object from the MCP tool call and must
parse it into a typed `TransitionEvent`.

### All event types round-trip correctly
- `BranchCreated` → `{ type: "BranchCreated" }`
- `TasksDecomposed` + tasks array → `{ type: "TasksDecomposed", tasks: [...] }`
- `TaskDone` → `{ type: "TaskDone" }`
- `TaskFailed` + failureReason → `{ type: "TaskFailed", failureReason: "..." }`
- `BuildPassed` → `{ type: "BuildPassed" }`
- `BuildFailed` + stderr → `{ type: "BuildFailed", stderr: "..." }`
- `DeployPassed` → `{ type: "DeployPassed" }`
- `DeployFailed` + stderr → `{ type: "DeployFailed", stderr: "..." }`
- `IntegPassed` → `{ type: "IntegPassed" }`
- `IntegFailed` + failures array → `{ type: "IntegFailed", failures: [...] }`
- `IntegFixPassed` → `{ type: "IntegFixPassed" }`
- `IntegFixFailed` → `{ type: "IntegFixFailed" }`
- `QualityDone` → `{ type: "QualityDone" }`
- `TreeClean` → `{ type: "TreeClean" }`
- `PrCreated` + prUrl → `{ type: "PrCreated", prUrl: "https://..." }`

### Invalid input throws a descriptive error
- Missing `event` field → throws with message indicating field is required
- Unknown event name → throws with message indicating the event name
