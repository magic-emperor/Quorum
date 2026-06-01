# Phase 2 — Provider-Agnostic AI Layer

> **Goal:** Make **any API key work**. Replace the hardcoded Anthropic client with an
> `LLMProvider` interface and adapters for OpenAI, Anthropic, Google (Gemini), DeepSeek, Groq,
> Moonshot (Kimi), Mistral, and OpenRouter. Each pipeline **role** (summarize / classify / plan /
> execute) picks a provider+model from config. Closes bug B5.

## Why now / dependencies
- **Depends on:** Phase 1 (correct flow; retry wired). Phase 3's agent harness and Phases 5–8's
  LLM calls all go through this layer, so it must exist first.

## Scope
**In:** provider interface, 8 adapters, capability detection, per-role model registry, JSON-mode
handling + repair, unified error→retry mapping, config + `.env` for all providers.
**Out:** tool-use execution loop (Phase 3 builds on the `tools=` parameter defined here).

## Design

### The interface — `qorum/providers/base.py`
```python
@dataclass
class LLMMessage:        # role: "system"|"user"|"assistant"|"tool"; content; tool_call_id?
    role: str; content: str; name: str | None = None; tool_call_id: str | None = None

@dataclass
class ToolSpec:          # provider-neutral tool description
    name: str; description: str; parameters: dict   # JSON Schema

@dataclass
class ToolCall:
    id: str; name: str; arguments: dict

@dataclass
class LLMResponse:
    text: str
    tool_calls: list[ToolCall]
    finish_reason: str          # "stop" | "tool_calls" | "length"
    usage: dict                 # input/output tokens
    raw: object

class Capabilities(BaseModel):
    native_tool_use: bool
    json_mode: bool
    max_output_tokens: int
    supports_system: bool

class LLMProvider(ABC):
    name: str
    @abstractmethod
    async def complete(self, messages: list[LLMMessage], *, model: str,
                       tools: list[ToolSpec] | None = None,
                       json_mode: bool = False,
                       max_tokens: int | None = None,
                       temperature: float = 0.2) -> LLMResponse: ...
    @abstractmethod
    def capabilities(self, model: str) -> Capabilities: ...
```

### Adapters — `qorum/providers/<name>.py`
| File | SDK / API | Tool use | JSON mode | Notes |
|------|-----------|---------|-----------|-------|
| `anthropic.py` | `anthropic` Messages | yes (native) | via prompt + stop | default executor |
| `openai.py` | `openai` Chat Completions / Responses | yes (native) | `response_format=json_object` | alt executor |
| `google.py` | `google-genai` | yes (function calling) | `response_mime_type=application/json` | Gemini |
| `deepseek.py` | OpenAI-compatible base_url | partial | json | reuse openai client w/ base_url |
| `groq.py` | OpenAI-compatible | partial | json | very fast, cheap → `fast` role |
| `moonshot.py` | OpenAI-compatible (Kimi) | partial | json | |
| `mistral.py` | `mistralai` | yes | json | |
| `openrouter.py` | OpenAI-compatible gateway | varies by model | varies | catch-all for "anything" |

> Most non-Anthropic/OpenAI providers are **OpenAI-API-compatible** → implement one
> `OpenAICompatibleProvider` base and parameterize `base_url`/`api_key`/capability flags;
> deepseek/groq/moonshot/openrouter are thin subclasses. Keeps adapter count low.

### Role registry — `qorum/providers/registry.py`
```python
ROLES = {"summarize", "classify", "plan", "phase_split", "testing", "execute"}
# config: quorum.config.json / env →  role -> {provider, model, max_tokens}
def provider_for(role: str) -> tuple[LLMProvider, str]: ...
def capabilities_for(role: str) -> Capabilities: ...
```
- Defaults: `summarize/classify` → a fast model (Groq/Haiku/Flash); `plan/phase_split/testing`
  → a default model (Sonnet/GPT-4o/Gemini-Pro); `execute` → a tool-capable default (Claude).
- Fallback chain per role (e.g. primary→secondary on auth/quota error) configurable.

### JSON-mode + repair
- Centralize the "must be pure JSON" handling here (currently inline in `plan_generator`).
  If `capabilities.json_mode` → use the native flag; else append the JSON-only instruction.
- On invalid JSON → one repair call (moved from Phase 1's local fix into the provider layer).

### Error mapping → retry
- Each adapter maps its SDK errors to shared exceptions: `ProviderAuthError`,
  `ProviderRateLimit(retry_after)`, `ProviderBadRequest`, `ProviderServerError`. `core/retry`
  retries rate-limit/server, surfaces auth/bad-request.

## File-level work breakdown
- `qorum/providers/{base,openai_compat,anthropic,openai,google,mistral,deepseek,groq,moonshot,openrouter,registry,errors}.py`
- `qorum/config.py` — replace single `anthropic_api_key` with a `providers` section:
  `QORUM_PROVIDER_<NAME>_API_KEY`, optional `QORUM_PROVIDER_<NAME>_BASE_URL`; role→model map.
- `qorum/core/plan_generator.py` — replace `anthropic.AsyncAnthropic` usage with
  `registry.provider_for("plan")` etc.; delete `_call_claude`, call `provider.complete`.
- `quorum.config.json` — formalize the schema already present (smart/balanced/fast → map to roles).

## Ordered tasks
1. `base.py` + `errors.py` + `OpenAICompatibleProvider`.
2. `anthropic.py`, `openai.py`, `google.py`, `mistral.py`; then the 4 OpenAI-compatible subclasses.
3. `registry.py` + config wiring + `.env.example` for all keys.
4. Refactor `plan_generator` to use the registry (remove Anthropic hardcode → closes B5).
5. Move JSON-mode + repair into the layer.
6. Tests + commit `feat: provider-agnostic AI layer`.

## Edge cases
- **Missing key for selected provider** → clear startup warning + actionable error at call time
  (which env var to set), not a stack trace.
- **Provider lacks `json_mode`** → prompt-enforced JSON + repair.
- **Provider lacks tool use** → `complete(tools=...)` returns `finish_reason="stop"`; the harness
  (Phase 3) detects this via `capabilities.native_tool_use=False` and switches to structured mode.
- **Token/cost tracking** → normalize `usage` across providers into `.quorum/context/budget-log.json`.
- **OpenRouter model strings** vary (`vendor/model`) → pass through untouched.

## Verification
- `tests/unit/test_providers_contract.py` — a shared contract test parametrized over every
  configured provider: same prompt → schema-valid JSON; respects `json_mode`; maps errors.
- `tests/integration/test_provider_smoke.py` (opt-in, needs keys) — one real call per provider
  that has a key in env; skipped otherwise.
- Manual: set only `QORUM_PROVIDER_OPENAI_API_KEY` (no Anthropic) → `/qorum <url>` generates a
  plan successfully.

## Definition of Done
- `plan_generator` and all role calls go through `LLMProvider`; no direct SDK import outside
  `qorum/providers/`.
- Switching providers is a config change, no code change.
- Contract test green for ≥3 providers; graceful, specific errors when a key is missing.
