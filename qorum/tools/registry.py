"""
Tool registry — maps tool names to QorumTool instances.
Used by the harness to dispatch ToolCalls.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from qorum.tools.base import QorumTool


class ToolRegistry:
    """Singleton-style registry; one instance per harness run."""

    def __init__(self) -> None:
        self._tools: dict[str, "QorumTool"] = {}

    def register(self, tool: "QorumTool") -> None:
        self._tools[tool.name] = tool

    def get(self, name: str) -> "QorumTool | None":
        return self._tools.get(name)

    def all_specs(self) -> list:
        """Return all ToolSpec objects (for passing to the provider)."""
        return [t.spec for t in self._tools.values()]

    def names(self) -> list[str]:
        return list(self._tools.keys())

    def __contains__(self, name: str) -> bool:
        return name in self._tools


def build_registry(tool_names: list[str]) -> "ToolRegistry":
    """
    Build a registry containing only the named tools.
    Lazy-imports each tool module to avoid loading optional deps until needed.
    """
    from qorum.tools.fs import (
        ReadFileTool, WriteFileTool, EditFileTool, ListDirTool, GlobTool,
    )
    from qorum.tools.search import GrepTool, FindSymbolTool
    from qorum.tools.shell import RunCommandTool
    from qorum.tools.git import (
        GitStatusTool, GitDiffTool, GitStashTool, GitBranchTool,
        GitAddTool, GitCommitTool,
    )
    from qorum.tools.test import RunTestsTool, RunBuildTool
    from qorum.tools.http import HttpFetchTool

    all_tools: list["QorumTool"] = [
        ReadFileTool(), WriteFileTool(), EditFileTool(), ListDirTool(), GlobTool(),
        GrepTool(), FindSymbolTool(),
        RunCommandTool(),
        GitStatusTool(), GitDiffTool(), GitStashTool(), GitBranchTool(),
        GitAddTool(), GitCommitTool(),
        RunTestsTool(), RunBuildTool(),
        HttpFetchTool(),
    ]

    registry = ToolRegistry()
    for tool in all_tools:
        if tool.name in tool_names:
            registry.register(tool)
    return registry
