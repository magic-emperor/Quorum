"""
Agent definition loader.
Agents are defined as YAML frontmatter + Markdown system prompt in agents/defs/*.md.
The loader parses them into AgentDef objects consumed by the harness.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

DEFS_DIR = Path(__file__).parent / "defs"


@dataclass
class AgentDef:
    """
    Parsed agent definition.
    Matches the YAML frontmatter + Markdown body in defs/*.md.
    """
    name: str
    description: str
    model_role: str                            # must match a key in providers.registry.ROLES
    allowed_tools: list[str] = field(default_factory=list)
    system_prompt: str = ""
    output_schema: Optional[str] = None        # JSON Schema name (optional)
    max_steps: int = 20
    max_tokens_total: int = 100_000


def load_agent(name: str) -> AgentDef:
    """Load an agent definition by name from the defs/ directory."""
    path = DEFS_DIR / f"{name}.md"
    if not path.exists():
        raise FileNotFoundError(f"Agent definition not found: {path}")
    return _parse_def(path.read_text(encoding="utf-8"), name)


def load_all() -> dict[str, AgentDef]:
    """Load all agent definitions from the defs/ directory."""
    return {path.stem: _parse_def(path.read_text(encoding="utf-8"), path.stem)
            for path in sorted(DEFS_DIR.glob("*.md"))}


def _parse_def(text: str, fallback_name: str) -> AgentDef:
    """Parse YAML frontmatter + Markdown body."""
    # Split frontmatter (--- ... ---) from body
    front: dict[str, object] = {}
    body = text
    fm_match = re.match(r"^---\s*\n(.*?)\n---\s*\n", text, re.DOTALL)
    if fm_match:
        try:
            import yaml  # type: ignore
            front = yaml.safe_load(fm_match.group(1)) or {}
        except ImportError:
            # Fallback: simple key: value parser
            for line in fm_match.group(1).splitlines():
                if ":" in line:
                    k, _, v = line.partition(":")
                    front[k.strip()] = v.strip()
        body = text[fm_match.end():]

    # Parse allowed_tools: can be a list or a comma-separated string
    raw_tools = front.get("allowed_tools", [])
    if isinstance(raw_tools, str):
        allowed = [t.strip() for t in raw_tools.split(",") if t.strip()]
    elif isinstance(raw_tools, list):
        allowed = [str(t) for t in raw_tools]
    else:
        allowed = []

    return AgentDef(
        name=str(front.get("name", fallback_name)),
        description=str(front.get("description", "")),
        model_role=str(front.get("model_role", "plan")),
        allowed_tools=allowed,
        system_prompt=body.strip(),
        output_schema=front.get("output_schema"),  # type: ignore[arg-type]
        max_steps=int(front.get("max_steps", 20)),
        max_tokens_total=int(front.get("max_tokens_total", 100_000)),
    )
