# Phase 3 — Qorum Tool + Agent Harness (the leveler)

> **Goal:** Build Qorum's **own tools and agents** so any provider can do real work. Capable
> providers (Claude/OpenAI) drive Qorum's tools via native function-calling; weak / no-tool-use
> providers fall back to a structured ReAct loop using the **same** Qorum tools. This is what
> makes "any API key works" true for *execution*, not just text generation.

## Why now / dependencies
- **Depends on:** Phase 2 (the `LLMProvider` interface, `ToolSpec`, `ToolCall`, capability flags).
- **Consumed by:** Phase 8 (execution engine drives this harness inside a repo).

## Scope
**In:** the tool layer (filesystem, shell, git, search, test-runner, http), the agent definition
format, the harness (native-tool-use loop + structured fallback loop), per-agent tool allow-lists,
a sandbox/permission policy. **Out:** wiring it into a real git branch + the chat flow (Phase 8),
streaming events to UIs (Phase 10).

## Design

### Tools — `qorum/tools/`
Every tool is a small class: a `ToolSpec` (name, description, JSON-Schema params) + an async
`run(args, ctx) -> ToolResult`. `ctx` carries the working directory (the target repo) and a
permission policy.
```
fs.py        read_file, write_file, edit_file (old/new string), list_dir, glob
search.py    grep (ripgrep-backed), find_symbol
shell.py     run_command (allow-list + timeout + cwd-locked)
git.py       status, diff, stash, branch, add, commit   (NO push tool by default)
test.py      run_tests, run_build   (autodetect: pytest/npm/gradle/go/maven — see Phase 9)
http.py      fetch (read-only, allow-list of hosts) — for docs lookups
```
- **`ToolResult`** = `{ ok: bool, output: str, data: dict|None, event: ToolEvent }`. The
  `event` field is what Phase 10 streams to the UIs (file opened/edited/created/deleted, command,
  test result) — define the `ToolEvent` schema **here** so execution emits it from day one.
- **Permission policy** (`qorum/tools/policy.py`): per-tool allow/deny, path jail (no writes
  outside the target repo), shell command allow-list/deny-list, network allow-list. Default deny
  for `push`, `rm -rf`, force operations.

### Agents — `qorum/agents/`
An agent = a Markdown/YAML definition: `name`, `description`, `model_role` (from Phase 2 registry),
`allowed_tools`, `system_prompt`, `output_schema?`. Loaded by `qorum/agents/loader.py`.
Initial roster (prompts can reuse the archived ATLAS agent specs as source material):
```
planner      reads context → emits PlanOutput (no file writes)        tools: read_file, glob, grep
classifier   actionability + work-type + complexity                    tools: read_file, grep
summarizer   chat messages → decisions/open-qs                         tools: (none)
locator      pick target repo, new-vs-enhancement                      tools: glob, grep, list_dir
coder        implement plan sub-tasks                                  tools: fs.*, search, shell, git(add/commit)
reviewer     critique a diff against the plan (evidence-only)          tools: read_file, git.diff, grep
tester       write/run tests, run build                                tools: fs.*, test.*, shell
integrator   reconcile multi-file / multi-phase work                   tools: read_file, grep, edit_file
```
- Each agent's `allowed_tools` is enforced by the harness — a summarizer literally cannot write
  files. This is the "assigning work to different agents" model: the orchestrator (Phase 8)
  picks the agent per classification, the agent's allow-list bounds what it can touch.

### The harness — `qorum/agent_harness.py`
```python
async def run_agent(agent: AgentDef, task: str, ctx: ToolContext,
                    on_event: Callable[[ToolEvent], None]) -> AgentRunResult:
    provider, model = registry.provider_for(agent.model_role)
    caps = provider.capabilities(model)
    if caps.native_tool_use:
        return await _run_native(...)     # provider function-calling loop
    return await _run_structured(...)     # ReAct JSON loop using the SAME tools
```
- **Native loop:** pass `tools=[ToolSpec...]`; on `finish_reason=="tool_calls"`, execute each
  `ToolCall` via the tool registry, append `tool` results, repeat until `stop` or step budget.
- **Structured loop:** system prompt instructs the model to reply with a strict JSON action
  `{ "thought": ..., "tool": name, "args": {...} }` or `{ "final": ... }`. Qorum parses, runs the
  tool, feeds the result back as the next user turn. Same tools, same permission policy — only the
  transport differs. This is the **inbuilt fallback** for providers lacking tool power.
- Shared concerns: max-steps budget, per-step + total token budget, `with_retry` on each provider
  call, full transcript saved to `.quorum/context/sessions/`, every `ToolResult.event` forwarded
  to `on_event`.

## File-level work breakdown
- `qorum/tools/{base,fs,search,shell,git,test,http,policy,registry,events}.py`
- `qorum/agents/{loader,defs/*.md}` (one def file per agent)
- `qorum/agent_harness.py`
- `tests/unit/test_tools_*.py`, `test_harness_native.py`, `test_harness_structured.py`

## Ordered tasks
1. `tools/base.py` (Tool, ToolResult, ToolEvent schemas) + `policy.py` + `registry.py`.
2. Implement fs, search, git, shell, test, http tools (each with path-jail + tests).
3. Agent def format + loader + the 8 def files.
4. `agent_harness._run_native` (test against a tool-capable provider or a mock).
5. `agent_harness._run_structured` (test against a no-tool mock provider).
6. Transcript + event + budget plumbing.
7. Commit `feat: qorum tool + agent harness`.

## Edge cases
- **Path-jail escape** (`../`, symlinks, absolute paths) → reject; test it explicitly.
- **Runaway loop** (model never finalizes) → max-steps hit → return partial + flag.
- **Malformed action JSON** (structured mode) → one reprompt ("reply with valid action JSON"),
  then abort the step.
- **Tool throws** → captured into `ToolResult.ok=False`, fed back so the model can recover.
- **Shell timeout / huge output** → truncate output, kill on timeout.
- **Native vs structured parity** → same task fixture must succeed in both loops (a key test).

## Verification
- Unit tests per tool (esp. path-jail, shell allow-list, git no-push).
- `test_harness_native` + `test_harness_structured`: a tiny "create file X with content Y, then
  read it back" task succeeds in **both** modes against mock providers.
- Parity test: identical task → equivalent final file state in native and structured loops.

## Definition of Done
- Tools enforce path-jail + permission policy; no `push` tool available by default.
- An agent runs to completion in both native and structured modes using the same tools.
- Every tool action emits a `ToolEvent` (ready for Phase 10 streaming).
- Agent tool allow-lists are enforced (summarizer can't write files).
