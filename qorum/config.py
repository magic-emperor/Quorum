"""
Qorum configuration — loaded from environment variables via pydantic-settings.
All secrets live in .env (gitignored). See .env.example for full documentation.
"""
from __future__ import annotations

from pathlib import Path
from typing import Literal, Optional

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class QorumConfig(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── Output ────────────────────────────────────────────────────────────────
    qorum_output_path: Path = Path("./qorum-output")

    # ── AI Provider Keys (Phase 2) ────────────────────────────────────────────
    # Legacy alias kept for Phase 1 compat; Phase 2+ reads the QORUM_PROVIDER_* vars
    anthropic_api_key: str = ""

    qorum_provider_anthropic_api_key: str = ""
    qorum_provider_openai_api_key: str = ""
    qorum_provider_google_api_key: str = ""
    qorum_provider_mistral_api_key: str = ""
    qorum_provider_deepseek_api_key: str = ""
    qorum_provider_deepseek_base_url: Optional[str] = None
    qorum_provider_groq_api_key: str = ""
    qorum_provider_moonshot_api_key: str = ""
    qorum_provider_openrouter_api_key: str = ""

    # ── Per-role provider overrides (optional) ────────────────────────────────
    # Set QORUM_ROLE_<ROLE>_PROVIDER and QORUM_ROLE_<ROLE>_MODEL to override defaults.
    # Roles: summarize, classify, plan, phase_split, testing, execute
    qorum_role_summarize_provider: Optional[str] = None
    qorum_role_summarize_model: Optional[str] = None
    qorum_role_classify_provider: Optional[str] = None
    qorum_role_classify_model: Optional[str] = None
    qorum_role_plan_provider: Optional[str] = None
    qorum_role_plan_model: Optional[str] = None
    qorum_role_phase_split_provider: Optional[str] = None
    qorum_role_phase_split_model: Optional[str] = None
    qorum_role_testing_provider: Optional[str] = None
    qorum_role_testing_model: Optional[str] = None
    qorum_role_execute_provider: Optional[str] = None
    qorum_role_execute_model: Optional[str] = None

    # ── Legacy model convenience fields (still usable but registry takes precedence) ─
    qorum_model_default: str = "claude-sonnet-4-6"
    qorum_model_fast: str = "claude-haiku-4-5-20251001"
    qorum_model_premium: str = "claude-opus-4-6"

    # ── Azure Boards ──────────────────────────────────────────────────────────
    azure_devops_pat: Optional[str] = None
    azure_devops_org: Optional[str] = None          # e.g. "mycompany"

    # ── Jira Cloud ────────────────────────────────────────────────────────────
    jira_cloud_email: Optional[str] = None
    jira_cloud_api_token: Optional[str] = None
    jira_cloud_base_url: Optional[str] = None       # e.g. "https://mycompany.atlassian.net"

    # ── Jira Server (self-hosted) ─────────────────────────────────────────────
    jira_server_pat: Optional[str] = None
    jira_server_base_url: Optional[str] = None      # e.g. "https://jira.mycompany.com"

    # ── GitHub ────────────────────────────────────────────────────────────────
    github_token: Optional[str] = None              # Personal access token, scope: issues:read

    # ── Linear ────────────────────────────────────────────────────────────────
    linear_api_key: Optional[str] = None

    # ── ClickUp ───────────────────────────────────────────────────────────────
    clickup_api_token: Optional[str] = None

    # ── Slack Bot ─────────────────────────────────────────────────────────────
    slack_bot_token: Optional[str] = None
    slack_signing_secret: Optional[str] = None
    slack_app_token: Optional[str] = None           # For Socket Mode

    # ── Discord Bot ───────────────────────────────────────────────────────────
    discord_bot_token: Optional[str] = None

    # ── Telegram Bot ─────────────────────────────────────────────────────────
    telegram_bot_token: Optional[str] = None

    # ── Microsoft Teams Bot (Phase 12) ───────────────────────────────────────
    qorum_teams_app_id: Optional[str] = None
    qorum_teams_app_password: Optional[str] = None
    qorum_teams_tenant_id: Optional[str] = None   # restrict to one tenant (optional)

    # ── WhatsApp Cloud API (Phase 13) ─────────────────────────────────────────
    qorum_whatsapp_token: Optional[str] = None
    qorum_whatsapp_phone_id: Optional[str] = None
    qorum_whatsapp_verify_token: Optional[str] = None
    qorum_whatsapp_app_secret: Optional[str] = None

    # ── SQLite state DB ───────────────────────────────────────────────────────
    qorum_db_path: Path = Path("./qorum.db")

    # ── Platform fallback (for self-hosted / ambiguous URLs) ─────────────────
    qorum_platform_override: Optional[str] = None   # e.g. "jira_server"
    qorum_platform_base_url: Optional[str] = None   # base URL for override platform

    # ── Behaviour flags ───────────────────────────────────────────────────────
    qorum_log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    qorum_cache_ttl_hours: int = 24
    qorum_max_children: int = 10                    # Max child items fetched per ticket
    qorum_large_ticket_phase_limit: int = 5         # Max auto-generated phases for large tickets
    qorum_max_tokens_plan: int = 8192               # B7: max tokens for plan/testing generation

    # ── Phase 5: Chat ingestion ───────────────────────────────────────────────
    qorum_capture_default_count: int = 30           # Messages to include in default look-back
    qorum_capture_default_minutes: int = 120        # Time cap for default look-back window

    # ── Phase 6: Classifier + Locator ────────────────────────────────────────
    qorum_registry_path: Path = Path("./registry.json")   # Channel→repo mapping file
    qorum_workspace_dir: Path = Path("./qorum-workspace")  # Scaffold dir for new projects

    # ── Phase 8/9: Execution + Gate ───────────────────────────────────────────
    qorum_auto_execute_on_approval: bool = False           # Auto-start execution after plan approved
    qorum_gate_fix_attempts: int = 2                       # Max auto-fix cycles on gate failure
    qorum_gate_timeout_seconds: int = 300                  # Per-step timeout (build/test)
    qorum_ci_provider: Optional[str] = None                # "github" | None
    qorum_stop_grace_seconds: int = 20                     # Grace before hard-cancel on Stop

    # ── Phase 14: Security + Sync hardening ───────────────────────────────────
    qorum_security_gate_enabled: bool = True               # Run security gate after build/test
    qorum_security_block_threshold: str = "high"           # critical|high|medium|low → block at/above
    qorum_security_dependency_audit: bool = True           # npm/pip/cargo audit in security gate
    qorum_secrets_scan_on_commit: bool = True              # Pre-commit secrets guard
    qorum_sync_mode: str = "cas"                           # "cas" | "server" (Phase 10 brokered)

    @field_validator("qorum_output_path", "qorum_db_path", "qorum_registry_path", "qorum_workspace_dir", mode="before")
    @classmethod
    def expand_path(cls, v: object) -> Path:
        return Path(str(v)).expanduser().resolve()

    @model_validator(mode="after")
    def sync_provider_keys(self) -> "QorumConfig":
        """
        Sync legacy anthropic_api_key ↔ qorum_provider_anthropic_api_key so both
        Phase 1 code paths (direct anthropic client) and Phase 2 (registry) work.
        """
        # If new key set but legacy empty, copy down
        if self.qorum_provider_anthropic_api_key and not self.anthropic_api_key:
            object.__setattr__(self, "anthropic_api_key", self.qorum_provider_anthropic_api_key)
        # If legacy set but new key empty, copy up
        elif self.anthropic_api_key and not self.qorum_provider_anthropic_api_key:
            object.__setattr__(self, "qorum_provider_anthropic_api_key", self.anthropic_api_key)

        # Warn only if no provider at all is configured
        has_any = any([
            self.qorum_provider_anthropic_api_key,
            self.qorum_provider_openai_api_key,
            self.qorum_provider_google_api_key,
            self.qorum_provider_mistral_api_key,
            self.qorum_provider_deepseek_api_key,
            self.qorum_provider_groq_api_key,
            self.qorum_provider_moonshot_api_key,
            self.qorum_provider_openrouter_api_key,
        ])
        if not has_any:
            import warnings as _w
            _w.warn(
                "No AI provider key is configured. "
                "Set at least one QORUM_PROVIDER_*_API_KEY in .env. "
                "AI generation will fail until a provider is configured.",
                stacklevel=2,
            )
        return self

    def has_platform_token(self, platform: str) -> bool:
        """Return True if the required token(s) for a platform are configured."""
        checks = {
            "azure_boards": bool(self.azure_devops_pat),
            "jira_cloud": bool(self.jira_cloud_email and self.jira_cloud_api_token),
            "jira_server": bool(self.jira_server_pat and self.jira_server_base_url),
            "github_issues": bool(self.github_token),
            "linear": bool(self.linear_api_key),
            "clickup": bool(self.clickup_api_token),
        }
        return checks.get(platform, False)

    def validate_tokens_on_startup(self) -> list:
        """Returns warning messages for missing tokens. Call at startup and log."""
        msgs: list = []

        if not self.anthropic_api_key:
            msgs.append("ANTHROPIC_API_KEY is not set — AI generation will fail.")

        configured_platforms = [
            p for p in ("azure_boards", "jira_cloud", "jira_server", "github_issues", "linear", "clickup")
            if self.has_platform_token(p)
        ]
        if not configured_platforms:
            msgs.append(
                "No ticket platform tokens configured. "
                "Set at least one platform token (e.g. AZURE_DEVOPS_PAT) in .env"
            )

        if not any([self.slack_bot_token, self.discord_bot_token, self.telegram_bot_token]):
            msgs.append(
                "No bot tokens configured. "
                "Set SLACK_BOT_TOKEN, DISCORD_BOT_TOKEN, or TELEGRAM_BOT_TOKEN to enable chat commands."
            )

        return msgs

    def ensure_output_dir(self) -> None:
        """Create the Qorum output directory if it doesn't exist."""
        self.qorum_output_path.mkdir(parents=True, exist_ok=True)
        (self.qorum_output_path / "plans").mkdir(exist_ok=True)


# Singleton — import and use `settings` everywhere
settings = QorumConfig()  # type: ignore[call-arg]
