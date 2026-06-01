"""
Platform detector — identifies which ticket platform a URL belongs to.
Uses regex patterns unique to each platform's URL structure.
Falls back to QORUM_PLATFORM_OVERRIDE config for self-hosted / ambiguous URLs.
"""
from __future__ import annotations

import re
from urllib.parse import urlparse

from qorum.adapters.base import Platform


# Patterns are ordered from most specific to least specific.
# Each entry: (platform, compiled_regex)
_PLATFORM_PATTERNS: list[tuple[Platform, re.Pattern[str]]] = [
    # Azure Boards
    # https://dev.azure.com/{org}/{project}/_workitems/edit/{id}
    # https://{org}.visualstudio.com/{project}/_workitems/edit/{id}
    (Platform.AZURE_BOARDS, re.compile(
        r"(dev\.azure\.com/.+/_workitems|visualstudio\.com/.+/_workitems)",
        re.IGNORECASE,
    )),

    # Jira Cloud
    # https://{org}.atlassian.net/browse/{PROJ-123}
    (Platform.JIRA_CLOUD, re.compile(
        r"\.atlassian\.net/browse/[A-Z][A-Z0-9]+-\d+",
        re.IGNORECASE,
    )),

    # GitHub Issues
    # https://github.com/{owner}/{repo}/issues/{id}
    (Platform.GITHUB_ISSUES, re.compile(
        r"github\.com/[^/]+/[^/]+/issues/\d+",
        re.IGNORECASE,
    )),

    # Linear
    # https://linear.app/{team}/issue/{id}/{slug}
    (Platform.LINEAR, re.compile(
        r"linear\.app/[^/]+/issue/",
        re.IGNORECASE,
    )),

    # ClickUp
    # https://app.clickup.com/t/{id}
    (Platform.CLICKUP, re.compile(
        r"app\.clickup\.com/t/",
        re.IGNORECASE,
    )),

    # Trello
    # https://trello.com/c/{id}/{slug}
    (Platform.TRELLO, re.compile(
        r"trello\.com/c/[a-zA-Z0-9]+",
        re.IGNORECASE,
    )),

    # Asana
    # https://app.asana.com/0/{project}/{task}
    (Platform.ASANA, re.compile(
        r"app\.asana\.com/\d+/\d+/\d+",
        re.IGNORECASE,
    )),

    # YouTrack (cloud)
    # https://{org}.youtrack.cloud/issue/{PROJ-123}
    # https://{org}.myjetbrains.com/youtrack/issue/{PROJ-123}
    (Platform.YOUTRACK, re.compile(
        r"(youtrack\.cloud/issue/|myjetbrains\.com/youtrack/issue/)[A-Z][A-Z0-9]+-\d+",
        re.IGNORECASE,
    )),

    # Notion (page URLs — less specific, kept last)
    # https://www.notion.so/{workspace}/{page-id}
    (Platform.NOTION, re.compile(
        r"notion\.so/[a-zA-Z0-9\-]+",
        re.IGNORECASE,
    )),

    # Jira Server — generic /browse/ pattern (must come AFTER Jira Cloud check)
    # https://{hostname}/browse/{PROJ-123}
    (Platform.JIRA_SERVER, re.compile(
        r"/browse/[A-Z][A-Z0-9]+-\d+",
        re.IGNORECASE,
    )),
]


class UnsupportedPlatformError(ValueError):
    """Raised when no platform can be detected from the URL."""


def detect_platform(url: str, override: str | None = None) -> Platform:
    """
    Identify which ticket platform a URL belongs to.

    Args:
        url: The full ticket/work item URL pasted by the user.
        override: Optional platform name from QORUM_PLATFORM_OVERRIDE config.
                  Used for self-hosted instances where URL patterns are ambiguous.

    Returns:
        Platform enum value.

    Raises:
        UnsupportedPlatformError: If no platform matches and no override is set.
    """
    if not url or not url.strip():
        raise UnsupportedPlatformError("URL is empty.")

    url = url.strip()

    # Validate it's a real URL before pattern matching
    try:
        parsed = urlparse(url)
        if not parsed.scheme or not parsed.netloc:
            raise UnsupportedPlatformError(
                f"'{url}' does not look like a valid URL. "
                "Make sure to include https://"
            )
    except Exception as exc:
        raise UnsupportedPlatformError(f"Could not parse URL: {exc}") from exc

    # Config-level override — validate first; if invalid, raise regardless of URL patterns.
    if override:
        try:
            return Platform(override.lower())
        except ValueError:
            raise UnsupportedPlatformError(
                f"QORUM_PLATFORM_OVERRIDE='{override}' is not a recognised platform. "
                f"Valid values: {', '.join(p.value for p in Platform if p != Platform.UNKNOWN)}"
            )

    # Try each pattern (only reached when no override is set)
    for platform, pattern in _PLATFORM_PATTERNS:
        if pattern.search(url):
            return platform

    raise UnsupportedPlatformError(
        f"Could not detect ticket platform from URL: {url}\n"
        "Supported platforms: Azure Boards, Jira Cloud/Server, GitHub Issues, Linear, ClickUp, Trello, Asana, YouTrack.\n"
        "For self-hosted instances, set QORUM_PLATFORM_OVERRIDE=<platform> in your .env file."
    )


def extract_ticket_id_from_url(url: str, platform: Platform) -> str:
    """
    Extract the ticket/work item ID from a URL.
    Returns a clean ID string (e.g. 'PROJ-123', '1234', 'issue-slug').
    """
    patterns: dict[Platform, re.Pattern[str]] = {
        Platform.AZURE_BOARDS: re.compile(r"_workitems/edit/(\d+)", re.IGNORECASE),
        Platform.JIRA_CLOUD: re.compile(r"/browse/([A-Z][A-Z0-9]+-\d+)", re.IGNORECASE),
        Platform.JIRA_SERVER: re.compile(r"/browse/([A-Z][A-Z0-9]+-\d+)", re.IGNORECASE),
        Platform.GITHUB_ISSUES: re.compile(r"/issues/(\d+)", re.IGNORECASE),
        Platform.LINEAR: re.compile(r"/issue/([A-Z0-9]+-\d+)", re.IGNORECASE),
        Platform.CLICKUP: re.compile(r"/t/([a-zA-Z0-9]+)", re.IGNORECASE),
        Platform.TRELLO: re.compile(r"/c/([a-zA-Z0-9]+)", re.IGNORECASE),
        Platform.ASANA: re.compile(r"/(\d+)/?$", re.IGNORECASE),
        Platform.YOUTRACK: re.compile(r"/issue/([A-Z][A-Z0-9]+-\d+)", re.IGNORECASE),
    }

    pattern = patterns.get(platform)
    if pattern:
        match = pattern.search(url)
        if match:
            return match.group(1)

    # Fallback: use last path segment
    path = urlparse(url).path.rstrip("/")
    return path.split("/")[-1] if path else url
