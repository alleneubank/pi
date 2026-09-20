# Asynchronous Bash processes

## Problem and solution

Long-running Bash tool calls hold the model turn open. Pi needs Bash to return while the same OS process keeps running, without adding a second process-management tool or requiring the model to poll for state.

Bash can transfer a local command to the background explicitly, after a foreground wait, or through the interactive background keybinding. The tool returns the child PID and durable output path. While the command is active, Pi injects a bounded runtime section before model requests. When it terminates, Pi delivers one bounded terminal notification. The agent uses ordinary Bash commands such as `ps` and `kill`, and Read or Bash for retained output.

## Domain model

A runtime-local process record contains the spawned OS PID, owner session and branch anchor, command, timestamps, lifecycle state, background reason, and output path. The process manager owns the child process tree, bounded output file, hard timeout, and cancellation. `AgentSession` owns transient active-process context and terminal-notification delivery.

Bash starts one process. It remains foreground until exit, transfers immediately when `runInBackground` is true, transfers after `yieldAfter` seconds, or transfers through the human keybinding. Transfer never reruns the command. `timeout` remains an independent hard execution deadline.

Process records are runtime state. Terminal notifications are immutable custom transcript messages. Replaying a transcript never creates a process. There is no model-facing process list, inspect, output, stop, or monitor API.

## Requirements

- **REQ-BGP-001 — Background Bash:** Local Bash can explicitly background a command or automatically yield an unfinished command after a separately configured foreground wait. Transfer never reruns the command. Bash returns the spawned OS PID and durable output path. The existing hard `timeout` remains a deadline and takes precedence when it expires first.
- **REQ-BGP-002 — Runtime context and completion:** Every model request made while owned background Bash commands are active receives one compact, bounded `<background_processes>` section containing each PID, command, background reason, and output path. The section is absent when no owned command is active. Termination appends exactly one terminal notification for that command and schedules a bounded continuation; elapsed wait time alone makes no model request.
- **REQ-BGP-004 — Bounded resources:** Runtime process count, retained process records, output bytes, active-context command text, terminal output, and pending terminal notifications have explicit limits. Crossing an execution limit produces visible terminal diagnostics and never silently claims complete output.
- **REQ-BGP-006 — Session ownership:** Extension reload retains process ownership. New, resumed, and forked sessions do not inherit processes. Tree navigation does not deliver notifications or active context whose branch anchor is outside the active branch. Runtime disposal cancels remaining owned process trees.
- **REQ-BGP-007 — Interruption and control:** Human interactive input can transfer the active Bash process with a configurable keybinding. Aborting a foreground Bash call, a Pi-owned timeout, print-mode disposal, and runtime disposal terminate the owned process tree. The model inspects and terminates background work only through existing Bash commands and reads retained output only through Read or Bash.
- **REQ-BGP-008 — Terminal reporting:** A terminal notification contains the PID, output path, exit code or termination signal, and bounded final output and diagnostics. A signal-terminated process is never described as having an unknown exit code. Concurrent completions schedule at most one pending wake-up.
- **REQ-BGP-009 — Mode policy:** Interactive, SDK, and RPC runtimes share active context and terminal delivery. Print mode gives background Bash a five-second completion grace before disposal and never waits indefinitely for a quiet process.
- **REQ-BGP-010 — Foreground compatibility:** Existing foreground Bash output, abort, hard timeout, spawn hooks, remote operations, renderers, and user `!` Bash behavior remain compatible. Unsupported custom execution backends reject background-only options rather than bypassing their authority.

## Invariants

- A PID identifies the one spawned child represented by a live record; a command's side effects start at most once.
- Only the owning `AgentSession` may expose active context or deliver a terminal notification.
- A background command produces at most one terminal event and one terminal transcript message.
- No model request is caused by elapsed wait time without terminal evidence.
- Process count is at most 32, retained process records at most 128, each output file at most 10 MiB, and all request or notification projections are bounded.
- Output backpressure pauses readable streams until the output file drains.
- Pi-owned timeout, abort, print-mode disposal, and runtime disposal target the process group, not only the shell parent.

## Decisions

- **2026-09-20, ratified:** `yieldAfter` is measured in seconds, defaults to 10, and `0` disables automatic yielding. `runInBackground` transfers immediately. `timeout` remains the hard deadline.
- **2026-09-21, ratified:** The spawned OS PID is the background-process identity exposed to the model and human. Existing platform commands are the only inspection and termination API.
- **2026-09-21, ratified:** Active process state is transient request context, not a durable transcript update. Terminal state is delivered once as a durable custom message.
- **2026-09-21, ratified:** Output overflow terminates the process and reports the bound in its terminal notification.

## Risk tags

High risk: this changes the public Bash tool contract and owns OS process cancellation. It requires one independent runtime/API review round for process leaks, PID and signal correctness, session misdelivery, request storms, and foreground compatibility, followed by fix-up confirmation and fresh terminal bug bashes.

## Non-goals

Processes do not survive quitting or restarting Pi. This feature does not add a daemon, scheduler, cron, remote execution protocol, Monitor tool, process/task stop tool, model-facing list or inspect API, process hierarchy, database, subagent orchestration, or background support to custom/remote Bash operations.

## Acceptance criteria

- [ ] Explicit, automatic, and human-triggered backgrounding return the spawned PID and output path without restarting the command.
- [ ] Active process context appears without polling and disappears after termination.
- [ ] One terminal notification reports normal exit and signal termination correctly with bounded output and diagnostics.
- [ ] Ordinary Bash `ps`/`kill` and Read/Bash output retrieval are sufficient; Monitor is absent from tools and public APIs.
- [ ] Limits and failures are visible; output, records, and process count stay bounded.
- [ ] Reload, tree navigation, session replacement, abort, timeout, print disposal, and runtime disposal preserve ownership and cleanup.
- [ ] Faux-provider tests show zero calls while waiting and bounded calls after concurrent completions.
- [ ] Print/RPC/SDK policies are executable and bounded.
- [ ] Foreground Bash and execution-authority regressions pass.
- [ ] Independent specialist review and both fresh model-backed terminal bug bashes report no unresolved P1/P2 finding.

## Test traceability

| Requirement | Executable evidence |
| --- | --- |
| REQ-BGP-001 | `test/suite/agent-session-background-processes.test.ts` explicit and yield cases; `test/process-manager.test.ts` same-process transfer and PID cases |
| REQ-BGP-002 | Agent-session active-context, completion, quiet-wait, and concurrent-completion cases |
| REQ-BGP-004 | `test/process-manager.test.ts` output, process-count, record, and disposal bounds |
| REQ-BGP-006 | Agent-session reload and inactive-branch cases; process-manager disposal case; fresh terminal `/new` task |
| REQ-BGP-007 | Agent-session foreground abort; process-manager process-tree case; fresh terminal keybinding, `ps`, `kill`, and output tasks |
| REQ-BGP-008 | Process-manager exit/signal cases and agent-session exactly-once notification assertions |
| REQ-BGP-009 | `test/print-mode-background-processes.test.ts`; RPC background-delivery case; packed SDK consumer smoke test |
| REQ-BGP-010 | Agent-session timeout case, existing Bash/tool regression suites, and independent runtime/API review |
