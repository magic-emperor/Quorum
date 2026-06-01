"""
Tool base classes — the contract every Qorum tool must implement.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

from qorum.providers.base import ToolSpec
from qorum.tools.events import ToolEvent


@dataclass
class ToolContext:
    """
    Runtime context passed to every tool invocation.
    Carries the working directory (target repo), the permission policy,
    the owning agent name, and the run ID for event tagging.
    """
    cwd: Path                              # repo root — the path jail boundary
    policy: "ToolPolicy"                   # type: ignore[forward-ref] — defined in policy.py
    agent: str = "unknown"
    run_id: str = ""
    on_event: Optional[Callable[[ToolEvent], None]] = None
    cancel_token: Optional[Any] = None     # CancellationToken — checked at safe points

    def emit(self, event: ToolEvent) -> None:
        event.agent = self.agent
        event.run_id = self.run_id
        if self.on_event:
            self.on_event(event)


@dataclass
class ToolResult:
    """
    Returned by every tool. The harness feeds this back to the model as context.
    """
    ok: bool
    output: str                            # text to feed back to the model
    data: dict[str, Any] = field(default_factory=dict)   # structured data (optional)
    event: Optional[ToolEvent] = None      # the event emitted by this action

    @classmethod
    def success(cls, output: str, data: dict | None = None,
                event: ToolEvent | None = None) -> "ToolResult":
        return cls(ok=True, output=output, data=data or {}, event=event)

    @classmethod
    def failure(cls, output: str, data: dict | None = None,
                event: ToolEvent | None = None) -> "ToolResult":
        return cls(ok=False, output=output, data=data or {}, event=event)


class QorumTool(ABC):
    """
    Abstract base for all Qorum tools.
    Each tool has a ToolSpec (name, description, JSON Schema) and a run method.
    """

    @property
    @abstractmethod
    def spec(self) -> ToolSpec:
        """The ToolSpec for this tool (name, description, parameters JSON Schema)."""
        ...

    @property
    def name(self) -> str:
        return self.spec.name

    @abstractmethod
    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        """Execute the tool. Must respect ctx.policy and emit ctx.on_event."""
        ...
