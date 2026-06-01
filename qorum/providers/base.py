"""
Provider interface — the contract every LLM adapter must implement.
All LLM calls in Qorum go through LLMProvider.complete(); no SDK is imported
outside the qorum/providers/ package.
"""
from __future__ import annotations

import json
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Optional

from pydantic import BaseModel


# ── Wire types ────────────────────────────────────────────────────────────────

@dataclass
class LLMMessage:
    """Provider-neutral chat message."""
    role: str                            # "system" | "user" | "assistant" | "tool"
    content: str
    name: Optional[str] = None           # for "tool" role: tool name
    tool_call_id: Optional[str] = None   # for "tool" role: links to ToolCall.id


@dataclass
class ToolSpec:
    """Provider-neutral tool description (JSON Schema for parameters)."""
    name: str
    description: str
    parameters: dict[str, Any]           # JSON Schema object


@dataclass
class ToolCall:
    """A tool invocation requested by the model."""
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class LLMResponse:
    """Normalised response from any provider."""
    text: str                            # Assistant message text (may be empty if tool_calls)
    tool_calls: list[ToolCall] = field(default_factory=list)
    finish_reason: str = "stop"          # "stop" | "tool_calls" | "length" | "error"
    usage: dict[str, int] = field(default_factory=dict)  # input_tokens, output_tokens
    raw: object = None                   # Original SDK response (for debugging)


# ── Capability manifest ───────────────────────────────────────────────────────

class Capabilities(BaseModel):
    """Static capability flags for a provider+model combination."""
    native_tool_use: bool = False        # Can the model call tools via function-calling API?
    json_mode: bool = False              # Native JSON mode available (no prompt needed)?
    max_output_tokens: int = 4096
    supports_system: bool = True         # Does the API accept a system message?
    context_window: int = 128_000
    native_web_search: bool = False      # Provider has built-in web search (Claude, Gemini)
    native_thinking: bool = False        # Provider has extended reasoning tokens (Claude 3.7+, o1/o3)


# ── Abstract base ─────────────────────────────────────────────────────────────

class LLMProvider(ABC):
    """
    Abstract base for all LLM providers.

    Subclasses implement complete() and capabilities().
    All error mapping to ProviderError subclasses is done inside complete().
    """

    name: str = "base"

    @abstractmethod
    async def complete(
        self,
        messages: list[LLMMessage],
        *,
        model: str,
        tools: Optional[list[ToolSpec]] = None,
        json_mode: bool = False,
        max_tokens: Optional[int] = None,
        temperature: float = 0.2,
    ) -> LLMResponse:
        """
        Send messages to the model and return a normalised response.
        Raises ProviderError subclasses on failure.
        """
        ...

    @abstractmethod
    def capabilities(self, model: str) -> Capabilities:
        """Return static capability flags for the given model."""
        ...

    def is_configured(self) -> bool:
        """Return True if the required API key(s) are set."""
        return True

    # ── Shared helpers ────────────────────────────────────────────────────────

    @staticmethod
    def build_json_system_suffix() -> str:
        """Instruction appended to system prompt when native JSON mode is unavailable."""
        return (
            "\n\nCRITICAL: Your response must be a single valid JSON object. "
            "No text before or after. No markdown code blocks. Pure JSON only."
        )

    @staticmethod
    def strip_fences(text: str) -> str:
        """Remove accidental markdown code fences."""
        text = text.strip()
        if text.startswith("```"):
            lines = text.splitlines()
            if lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].strip() == "```":
                lines = lines[:-1]
            text = "\n".join(lines)
        return text.strip()

    def validate_json_or_raise(self, text: str, label: str) -> str:
        """Strip fences, try to parse as JSON. Returns cleaned text or raises ValueError."""
        cleaned = self.strip_fences(text)
        json.loads(cleaned)  # raises ValueError / json.JSONDecodeError on bad JSON
        return cleaned
