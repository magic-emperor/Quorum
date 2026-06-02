"""
Qorum Bot Base Adapter — unified interface all bot platforms implement.

Each platform adapter inherits this class and overrides the abstract methods.
The orchestrator and approval pipeline are platform-agnostic; the adapter
handles all platform-specific formatting, button rendering, and message posting.

Phase 1 command surface (/qorum <url>, status, view, refresh, help) is unchanged.
Phase 4 adds: fetch_history, get_thread, send_buttons, edit_message, on_mention,
on_button, dispatch_button — the event-driven message model.
"""
from __future__ import annotations

import asyncio
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Any, Callable, Optional

from qorum.bot.actions import BotAction
from qorum.bot.buttons import Button
from qorum.bot.events import ButtonClick, ChatContext, ChatMessage, ChatUser
from qorum.core.logger import get_logger
from qorum.core.orchestrator import QorumOrchestrator, OrchestratorError, PlanMode

if TYPE_CHECKING:
    from qorum.config import QorumConfig

log = get_logger(__name__)


class ButtonAction(str, Enum):
    APPROVE         = "qorum_approve"
    REQUEST_CHANGES = "qorum_request_changes"
    MARK_DONE       = "qorum_mark_done"
    FEEDBACK_HELPFUL    = "qorum_feedback_helpful"
    FEEDBACK_NEEDS_WORK = "qorum_feedback_needs_work"
    FEEDBACK_FLAG       = "qorum_feedback_flag"


@dataclass
class BotContext:
    """Platform-agnostic context for a single incoming command."""
    platform: str           # "slack" | "discord" | "telegram"
    channel_id: str
    user_id: str
    username: str | None
    raw: Any                # Platform-specific event/interaction object


# ── Command parsing ───────────────────────────────────────────────────────────

_URL_RE = re.compile(r"https?://\S+")

def parse_qorum_command(text: str) -> tuple[str | None, dict[str, Any]]:
    """
    Parse /atlas command text.
    Returns (subcommand_or_url, flags_dict).

    Examples:
      "/atlas https://github.com/org/repo/issues/1"
        → ("https://github.com/org/repo/issues/1", {})
      "/atlas https://... --brief"
        → ("https://github.com/org/repo/issues/1", {"brief": True})
      "/atlas status"
        → ("status", {})
      "/atlas view PROJ-123"
        → ("view", {"ticket_id": "PROJ-123"})
      "/atlas refresh PROJ-123"
        → ("refresh", {"ticket_id": "PROJ-123"})
      "/atlas help"
        → ("help", {})
    """
    # Strip /qorum or /atlas prefix (/qorum is primary; /atlas kept as alias)
    text = text.strip()
    for prefix in ("/qorum ", "/qorum", "/atlas ", "/atlas"):
        if text.startswith(prefix):
            text = text[len(prefix):].strip()
            break

    flags: dict[str, Any] = {}
    if "--brief" in text:
        flags["brief"] = True
        text = text.replace("--brief", "").strip()

    if not text:
        return ("help", flags)

    # URL command
    url_match = _URL_RE.search(text)
    if url_match:
        return (url_match.group(0), flags)

    # Keyword commands
    parts = text.split(maxsplit=1)
    subcommand = parts[0].lower()
    if subcommand in ("status", "help", "stats", "where"):
        return (subcommand, flags)
    if subcommand in ("view", "refresh"):
        if len(parts) > 1:
            flags["ticket_id"] = parts[1].strip()
        return (subcommand, flags)
    if subcommand == "map":
        if len(parts) > 1:
            flags["repo_path"] = parts[1].strip()
        return (subcommand, flags)
    if subcommand == "link":
        if len(parts) > 1:
            flags["link_arg"] = parts[1].strip()
        return (subcommand, flags)

    return (None, flags)  # unrecognised


# ── Base adapter ──────────────────────────────────────────────────────────────

class BaseQorumAdapter(ABC):
    """
    Abstract base for all platform bot adapters.

    Concrete subclasses must implement the abstract send/reply methods.
    The command handling logic is shared here so it only lives once.
    """

    HELP_TEXT = (
        "*Qorum — Commands*\n\n"
        "`/qorum <url>` — Generate plan for a ticket\n"
        "`/qorum <url> --brief` — Summary only (no approval flow)\n"
        "`/qorum status` — List last 10 plans\n"
        "`/qorum stats` — Team usage summary\n"
        "`/qorum view <id>` — Show plan paths for a ticket\n"
        "`/qorum refresh <id>` — Force-regenerate plan\n"
        "`/qorum map <repo-path>` — Map this channel to a local repo\n"
        "`/qorum where` — Show which repo this channel is mapped to\n"
        "`/qorum link <name>` — Link your chat account to a Qorum contributor\n"
        "`/qorum help` — Show this message\n\n"
        "_@mention @Qorum with 'plan' to trigger from chat conversation._\n"
        "_Note: `/atlas` commands also work as an alias._"
    )

    def __init__(self, config: "QorumConfig", orchestrator: QorumOrchestrator) -> None:
        self._config = config
        self._orchestrator = orchestrator
        # Phase 5: pending capture sessions keyed by capture_id
        # Value: (CaptureWindow, ChatContext, BoundaryEngine)
        self._capture_sessions: dict = {}
        self._capture_card_messages: dict[str, str] = {}   # capture_id → card message_id
        # Phase 7: quorum approval state keyed by plan_id
        self._quorum_sessions: dict = {}   # plan_id → QuorumState
        # Phase 8: execution results pending diff approval keyed by plan_id
        self._execution_results: dict = {}   # plan_id → (ExecutionResult, ExecutionRunner)
        # Phase 14.1: live executions keyed by plan_id → (asyncio.Task, CancellationToken)
        self._active_executions: dict = {}
        self._progress_cards: dict[str, str] = {}   # plan_id → progress card message_id

    # ── Abstract interface (platform-specific) ────────────────────────────────

    @abstractmethod
    async def send_message(self, channel_id: str, text: str, **kwargs: Any) -> Any:
        """Post a plain text (or formatted markdown) message to a channel/chat."""

    @abstractmethod
    async def send_approval_buttons(
        self,
        channel_id: str,
        ticket_id: str,
        plan_paths: list[str],
        inline_summary: str,
    ) -> Any:
        """Post the plan summary with [✅ Approve Plan] [✏️ Request Changes] buttons."""

    @abstractmethod
    async def send_testing_ready(
        self,
        channel_id: str,
        ticket_id: str,
        testing_paths: list[str],
    ) -> Any:
        """Post a message indicating testing.md is ready, with [🚀 Mark Done] button."""

    @abstractmethod
    async def send_done(
        self,
        channel_id: str,
        ticket_id: str,
        walkthrough_path: str,
    ) -> Any:
        """Post the completion message with walkthrough.md path."""

    @abstractmethod
    async def send_feedback_buttons(
        self,
        channel_id: str,
        ticket_id: str,
        artifact_type: str,
    ) -> Any:
        """Post 👍 Helpful / 👎 Needs Work / ✏️ Flag Issue buttons after an artifact."""

    @abstractmethod
    async def prompt_for_feedback(self, channel_id: str, ticket_id: str) -> Any:
        """Ask the user to type their change request feedback."""

    @abstractmethod
    async def start(self) -> None:
        """Start the bot (connect, register handlers, begin polling or socket mode)."""

    @abstractmethod
    async def stop(self) -> None:
        """Gracefully stop the bot."""

    # ── Phase 4: event-driven message model (new abstract methods) ────────────

    async def fetch_history(
        self,
        channel_id: str,
        *,
        thread_id: Optional[str] = None,
        anchor_message_id: Optional[str] = None,
        limit: int = 200,
    ) -> list[ChatMessage]:
        """
        Fetch recent messages from a channel or thread.
        Platforms without a history API (Telegram) return from their rolling buffer.
        Returns empty list if not supported rather than raising.
        """
        return []

    async def get_thread(
        self,
        channel_id: str,
        thread_id: str,
    ) -> list[ChatMessage]:
        """Return all messages in a reply thread. Empty list if not supported."""
        return []

    async def send_buttons(
        self,
        channel_id: str,
        text: str,
        buttons: list[Button],
        thread_id: Optional[str] = None,
    ) -> str:
        """
        Post a message with inline buttons. Returns the message_id.
        Default implementation falls back to send_message (no buttons).
        Override in each platform adapter.
        """
        await self.send_message(channel_id, text)
        return ""

    async def edit_message(
        self,
        channel_id: str,
        message_id: str,
        text: str,
        buttons: Optional[list[Button]] = None,
    ) -> None:
        """Update an existing message. No-op if not supported."""

    async def buffer_oldest_ts(self, channel_id: str) -> Optional["datetime"]:
        """
        Return the oldest buffered message timestamp for platforms with a rolling buffer.
        Returns None for platforms that have a native history API (Slack, Teams).
        Telegram overrides this to surface the buffer limit to the confirm card.
        """
        return None

    async def on_mention(
        self,
        handler: Callable[[ChatContext], Any],
    ) -> None:
        """Register a handler called whenever the bot is @mentioned or /qorum is used."""

    async def on_button(
        self,
        handler: Callable[[ButtonClick], Any],
    ) -> None:
        """Register a handler called on every button callback."""

    # ── Platform-neutral button dispatcher ───────────────────────────────────

    async def dispatch_button(self, click: ButtonClick) -> None:
        """
        Route a button click to the correct orchestrator action.
        Called by every platform's button callback handler.
        """
        action = click.action
        payload = click.payload
        ticket_id = payload.get("ticket_id", "")

        log.info(
            "bot.button_click",
            action=action,
            ticket_id=ticket_id,
            user=click.user.display_name,
        )

        if action == BotAction.APPROVE:
            await self.handle_approve(
                BotContext(click.platform, click.channel_id,
                           click.user.id, click.user.display_name, click.raw),
                ticket_id,
            )

        elif action == BotAction.REQUEST_CHANGES:
            # Phase 7 will add text collection; for now prompt and re-generate
            await self.send_message(
                click.channel_id,
                f"Please type your feedback for `{ticket_id}` as a reply.",
            )

        elif action == BotAction.REJECT:
            await self.send_message(
                click.channel_id,
                f"Plan for `{ticket_id}` rejected. The thread remains open — continue discussing and re-run `/qorum plan`.",
            )

        elif action == BotAction.MARK_DONE:
            await self.handle_mark_done(
                BotContext(click.platform, click.channel_id,
                           click.user.id, click.user.display_name, click.raw),
                ticket_id,
                {},  # Phase 7 populates walkthrough data
            )

        elif action in (BotAction.FEEDBACK_HELPFUL, BotAction.FEEDBACK_NEEDS_WORK):
            rating = "helpful" if action == BotAction.FEEDBACK_HELPFUL else "needs_work"
            artifact = payload.get("artifact", "plan")
            await self.handle_feedback(
                BotContext(click.platform, click.channel_id,
                           click.user.id, click.user.display_name, click.raw),
                ticket_id, artifact, rating,
            )

        # ── Phase 5: boundary confirm-card buttons ────────────────────────────
        elif action == BotAction.BOUNDARY_PROCEED:
            capture_id = payload.get("capture_id", "")
            await self.handle_boundary_proceed(click.channel_id, capture_id, click.message_id)

        elif action == BotAction.BOUNDARY_TRIM:
            capture_id = payload.get("capture_id", "")
            await self.handle_boundary_adjust(
                click.channel_id, capture_id, click.message_id, "trim"
            )

        elif action == BotAction.BOUNDARY_EXPAND:
            capture_id = payload.get("capture_id", "")
            await self.handle_boundary_adjust(
                click.channel_id, capture_id, click.message_id, "expand"
            )

        elif action == BotAction.BOUNDARY_CANCEL:
            capture_id = payload.get("capture_id", "")
            self._capture_sessions.pop(capture_id, None)
            await self.edit_message(
                click.channel_id, click.message_id, "_Capture cancelled._"
            )

        # ── Phase 8: execution buttons ────────────────────────────────────────
        elif action == BotAction.EXECUTE:
            plan_id = payload.get("ticket_id", "")
            await self.handle_execute(click.channel_id, plan_id)

        elif action == BotAction.STOP_EXECUTION:
            plan_id = payload.get("ticket_id", "")
            await self.handle_stop_execution(click.channel_id, plan_id)

        elif action == BotAction.KEEP_BRANCH:
            plan_id = payload.get("ticket_id", "")
            await self.handle_keep_branch(click.channel_id, plan_id)

        elif action == BotAction.APPROVE_DIFF:
            plan_id = payload.get("ticket_id", "")
            await self.handle_approve_diff(click.channel_id, plan_id, click.message_id)

        elif action == BotAction.DISCARD_DIFF:
            plan_id = payload.get("ticket_id", "")
            await self.handle_discard_diff(click.channel_id, plan_id, click.message_id)

        else:
            log.warning("bot.unknown_action", action=action)

    # ── Phase 5: mention handler (boundary → confirm card → summarise) ────────

    async def handle_mention(self, ctx: ChatContext) -> None:
        """
        Called by on_mention handlers when @Qorum or /qorum plan is triggered.
        Resolves the capture window, posts a confirm card, and waits for approval.
        """
        from qorum.collaboration.ingester import BoundaryEngine
        from qorum.bot.buttons import boundary_buttons

        engine = BoundaryEngine(self._config)
        capture = await engine.resolve_window(ctx, self)

        # Store the capture keyed by capture_id for the confirm-card button handlers
        self._capture_sessions[capture.capture_id] = (capture, ctx, engine)

        card_text = capture.confirm_card_text()
        msg_id = await self.send_buttons(
            ctx.channel_id,
            card_text,
            boundary_buttons(capture.capture_id),
            thread_id=ctx.thread_id,
        )
        # Store the card's message_id so we can edit it on Trim/Expand
        self._capture_card_messages[capture.capture_id] = msg_id

        log.info(
            "bot.confirm_card_sent",
            capture_id=capture.capture_id,
            strategy=capture.strategy,
            messages=capture.message_count,
        )

    async def handle_boundary_proceed(
        self,
        channel_id: str,
        capture_id: str,
        card_message_id: str,
    ) -> None:
        """User confirmed the window — summarise and build Intent."""
        session = self._capture_sessions.pop(capture_id, None)
        if not session:
            await self.send_message(channel_id, "_Session expired. Please re-trigger @Qorum._")
            return

        capture, ctx, _ = session
        await self.edit_message(
            channel_id, card_message_id,
            f"✅ Got it — reading *{capture.message_count} messages* and summarising..."
        )

        from qorum.collaboration.clean import strip_noise
        from qorum.collaboration.summarizer import ChatSummarizer, SummarizationError
        from qorum.collaboration.intent import Intent

        cleaned = strip_noise(capture.messages)

        try:
            summarizer = ChatSummarizer(self._config)
            summary = await summarizer.summarise(capture, cleaned)

            quorum_dir = getattr(self._config, "qorum_output_path", None)
            if quorum_dir:
                await summarizer.persist(capture, summary, quorum_dir)
        except SummarizationError as exc:
            log.error("bot.summarise_failed", error=str(exc))
            await self.send_message(
                channel_id,
                "⚠ Summarisation failed. Please try again or describe the task directly.",
            )
            return

        intent = Intent(
            source="chat",
            author=ctx.trigger_message.author,
            capture=capture,
            summary=summary,
            links=summary.links,
            raw_ref={"channel_id": channel_id, "thread_id": ctx.thread_id},
        )

        if not intent.is_actionable:
            await self.send_message(
                channel_id,
                "I couldn't identify any clear decisions or tasks in this conversation. "
                "Could you describe what you'd like to build?",
            )
            return

        # ── Phase 6: classify → locate ────────────────────────────────────────
        from qorum.collaboration.classifier import IntentClassifier, ClassificationError
        from qorum.collaboration.locator import ProjectLocator
        from qorum.collaboration.registry import ProjectRegistry

        await self.send_message(channel_id, "_Classifying work type..._")

        try:
            classifier = IntentClassifier(self._config)
            classification = await classifier.classify(intent)
        except ClassificationError as exc:
            log.error("bot.classify_failed", error=str(exc))
            await self.send_message(channel_id, "⚠ Classification failed. Please try again.")
            return

        if classification.needs_clarification:
            await self.send_message(channel_id, classification.clarifying_question or "Could you clarify the request?")
            return

        if classification.is_question_only:
            await self.send_message(
                channel_id,
                f"_{intent.title_hint or 'Question'}_\n\n{intent.summary.context if intent.summary else ''}",
            )
            return

        registry = ProjectRegistry(self._config.qorum_registry_path)
        locator = ProjectLocator(registry, self._config)
        locate_result = await locator.locate(intent, classification)

        if locate_result.needs_human_input:
            await self.send_message(
                channel_id,
                locate_result.clarifying_question or "I need more information about the target repo.",
            )
            return

        # Re-persist summary to the correct plan_dir (target repo's .quorum/)
        if locate_result.plan_dir and summary:
            locate_result.plan_dir.mkdir(parents=True, exist_ok=True)
            summarizer = ChatSummarizer(self._config)
            await summarizer.persist(capture, summary, locate_result.plan_dir.parent)

        # ── Phase 7: synthesise plan → write to target .quorum/ → approval card ─
        from qorum.core.plan_generator import QorumPlanGenerator, PlanGenerationError
        from qorum.output.manager import QorumOutputManager
        from qorum.approval.quorum import QuorumConfig, QuorumState, ApprovalVote, QuorumVerdict, evaluate
        from qorum.approval.card import build_approval_card
        from qorum.bot.buttons import approval_buttons

        await self.send_message(channel_id, "_Synthesising plan..._")

        try:
            generator = QorumPlanGenerator(self._config)
            gen_result = await generator.generate_plan_from_intent(intent, classification)
        except PlanGenerationError as exc:
            log.error("bot.plan_gen_failed", error=str(exc))
            await self.send_message(channel_id, f"⚠ Plan generation failed: {exc}")
            return

        # Write plan.md + task.md into target .quorum/
        plan_id = gen_result.ticket_id
        output_mgr = QorumOutputManager(self._config)
        saved = await output_mgr.save_plans_to_dir(
            plan_id=plan_id,
            gen_result=gen_result,
            plan_dir=locate_result.plan_dir,
        )

        # Load quorum config for this repo
        quorum_cfg = QuorumConfig.from_plan_dir(locate_result.plan_dir) if locate_result.plan_dir else QuorumConfig()
        first_plan = gen_result.plans[0].plan if gen_result.plans else None

        if not first_plan:
            await self.send_message(channel_id, "⚠ No plan generated.")
            return

        # Persist approval state
        quorum_state = QuorumState(
            plan_id=plan_id,
            config=quorum_cfg,
            trigger_user_id=ctx.trigger_message.author.id,
        )
        self._quorum_sessions[plan_id] = quorum_state

        # Append audit event
        await self._orchestrator.append_audit_event(
            plan_id, "plan_created",
            actor=ctx.trigger_message.author.display_name,
            detail={"work_type": classification.work_type, "locate_mode": locate_result.mode},
        )

        # Post the approval card
        card_text = build_approval_card(plan_id, first_plan, intent, classification, locate_result, quorum_cfg)
        await self.send_buttons(channel_id, card_text, approval_buttons(plan_id), thread_id=ctx.thread_id)

        log.info(
            "bot.approval_card_sent",
            plan_id=plan_id,
            work_type=classification.work_type,
            locate_mode=locate_result.mode,
            plan_dir=str(locate_result.plan_dir),
        )

    async def handle_boundary_adjust(
        self,
        channel_id: str,
        capture_id: str,
        card_message_id: str,
        direction: str,  # "trim" | "expand"
    ) -> None:
        """User clicked Trim or Expand — update the window and edit the card."""
        session = self._capture_sessions.get(capture_id)
        if not session:
            await self.send_message(channel_id, "_Session expired. Please re-trigger @Qorum._")
            return

        capture, ctx, engine = session

        if direction == "trim":
            new_capture = await engine.trim_window(capture, steps=10)
        else:
            new_capture = await engine.expand_window(capture, self, steps=10)

        self._capture_sessions[capture_id] = (new_capture, ctx, engine)

        from qorum.bot.buttons import boundary_buttons
        await self.edit_message(
            channel_id,
            card_message_id,
            new_capture.confirm_card_text(),
            buttons=boundary_buttons(capture_id),
        )

    # ── Shared command handlers ───────────────────────────────────────────────

    async def handle_command(self, ctx: BotContext, text: str) -> None:
        """
        Entry point for any /atlas command. Dispatches to the appropriate handler.
        All platform adapters route their slash command / message events here.
        """
        subcommand, flags = parse_qorum_command(text)

        if subcommand is None:
            await self.send_message(
                ctx.channel_id,
                "Unknown command. Try `/qorum help` for usage.",
            )
            return

        if subcommand == "help":
            await self.send_message(ctx.channel_id, self.HELP_TEXT)

        elif subcommand == "status":
            await self._handle_status(ctx)

        elif subcommand == "stats":
            await self._handle_stats(ctx)

        elif subcommand == "view":
            await self._handle_view(ctx, flags.get("ticket_id", ""))

        elif subcommand == "refresh":
            await self._handle_refresh(ctx, flags.get("ticket_id", ""))

        elif subcommand == "map":
            await self._handle_map(ctx, flags.get("repo_path", ""))

        elif subcommand == "where":
            await self._handle_where(ctx)

        elif subcommand == "link":
            await self._handle_link(ctx, flags.get("link_arg", ""))

        elif subcommand in ("plan", "stop", "cancel"):
            # These are handled by the mention/button handlers — no action needed here
            pass

        elif _URL_RE.match(subcommand):
            mode = PlanMode.BRIEF if flags.get("brief") else PlanMode.FULL
            await self._handle_url(ctx, subcommand, mode)

        else:
            await self.send_message(
                ctx.channel_id,
                f"Unknown command `{subcommand}`. Try `/qorum help`.",
            )

    async def handle_approve(self, ctx: BotContext, ticket_id: str) -> None:
        """Handle [✅ Approve Plan] button press — evaluates quorum before proceeding."""
        from qorum.approval.quorum import ApprovalVote, QuorumVerdict, evaluate

        # Phase 7: quorum vote path
        qs = self._quorum_sessions.get(ticket_id)
        if qs is not None:
            vote = ApprovalVote(
                user_id=ctx.user_id,
                display_name=ctx.username,
                verdict=QuorumVerdict.APPROVED,
            )
            qs.add_vote(vote)
            await self._orchestrator.record_vote(
                ticket_id, ctx.user_id, ctx.username, "APPROVED"
            )
            await self._orchestrator.append_audit_event(
                ticket_id, "vote", actor=ctx.username, detail={"verdict": "APPROVED"}
            )
            verdict = evaluate(qs)
            if verdict == QuorumVerdict.PENDING:
                approved_so_far = len(qs.approved_by)
                required = len(qs.config.required_approvers) or "?"
                await self.send_message(
                    ctx.channel_id,
                    f"✅ {ctx.username or ctx.user_id} approved. "
                    f"Waiting for quorum ({approved_so_far}/{required} so far, rule: {qs.config.rule}).",
                )
                return
            if verdict == QuorumVerdict.REJECTED:
                await self.send_message(ctx.channel_id, "✖ Plan rejected by quorum.")
                return
            if verdict == QuorumVerdict.EXPIRED:
                await self.send_message(ctx.channel_id, "⏱ Approval window has expired. Please re-run planning.")
                return
            # APPROVED — fall through to existing approval pipeline
            await self._orchestrator.append_audit_event(
                ticket_id, "approved", actor=ctx.username, detail={"rule": qs.config.rule}
            )
            del self._quorum_sessions[ticket_id]

        ticket, generation_result = await self._load_session(ctx.channel_id, ticket_id)
        if ticket is None or generation_result is None:
            return  # _load_session already posted the error message

        result = await self._orchestrator.approve(
            ticket, generation_result, approved_by=ctx.username
        )

        if isinstance(result, OrchestratorError):
            await self.send_message(ctx.channel_id, f"Approval failed: {result.message}")
            return

        await self.send_testing_ready(
            ctx.channel_id, ticket_id, result.testing_paths
        )
        await self.send_feedback_buttons(ctx.channel_id, ticket_id, "testing")

    async def handle_request_changes(
        self, ctx: BotContext, ticket_id: str, feedback_text: str
    ) -> None:
        """Handle [✏️ Request Changes] + collected feedback text. (B3: feedback threaded)"""
        ticket, _ = await self._load_session(ctx.channel_id, ticket_id)
        if ticket is None:
            return

        await self._orchestrator.request_changes(ticket, feedback_text, actor=ctx.username)

        await self.send_message(
            ctx.channel_id, f"Regenerating plan for `{ticket_id}` with your feedback..."
        )
        # Regenerate with feedback threaded in (B3)
        await self._handle_url(ctx, ticket.url, PlanMode.FULL, feedback=feedback_text)

    async def handle_feedback(
        self,
        ctx: BotContext,
        ticket_id: str,
        artifact_type: str,
        rating: str,
        comment: str | None = None,
        sections_flagged: list[str] | None = None,
    ) -> None:
        """Handle 👍 / 👎 / ✏️ feedback button press."""
        await self._orchestrator.record_feedback(  # public API (B8)
            ticket_id=ticket_id,
            artifact_type=artifact_type,
            rating=rating,
            sections_flagged=sections_flagged,
            comment=comment,
            actor=ctx.username,
        )

        if rating == "helpful":
            ack = f"Thanks! Feedback recorded for `{ticket_id}` — glad it was helpful. 👍"
        elif rating == "needs_work":
            ack = (
                f"Feedback recorded for `{ticket_id}`. "
                f"This plan has been flagged for prompt improvement review. 👎"
            )
        else:
            ack = f"Feedback recorded for `{ticket_id}`. ✏️"

        await self.send_message(ctx.channel_id, ack)

    async def handle_mark_done(
        self, ctx: BotContext, ticket_id: str, walkthrough_data: dict
    ) -> None:
        """Handle [🚀 Mark Done] after walkthrough fields collected from developer."""
        from qorum.output.renderer import PlanVsRealityDiff, TechnicalDecision, WalkthroughData

        ticket, _ = await self._load_session(ctx.channel_id, ticket_id)
        if ticket is None:
            return

        walkthrough = WalkthroughData(
            executive_summary=walkthrough_data.get("summary", ""),
            how_to_run=walkthrough_data.get("how_to_run", []),
            plan_vs_reality=[
                PlanVsRealityDiff(**d) for d in walkthrough_data.get("plan_vs_reality", [])
            ],
            technical_decisions=[
                TechnicalDecision(**d) for d in walkthrough_data.get("technical_decisions", [])
            ],
            known_issues=walkthrough_data.get("known_issues", []),
            deployment_steps=walkthrough_data.get("deployment_steps", []),
            rollback_steps=walkthrough_data.get("rollback_steps", []),
            linked_prs=walkthrough_data.get("linked_prs", []),
            signoff_checklist=walkthrough_data.get("signoff_checklist", []),
        )

        result = await self._orchestrator.mark_done(
            ticket, walkthrough, completed_by=ctx.username
        )

        if isinstance(result, OrchestratorError):
            await self.send_message(ctx.channel_id, f"Could not mark done: {result.message}")
            return

        await self.send_done(ctx.channel_id, ticket_id, result.walkthrough_path or "")
        await self.send_feedback_buttons(ctx.channel_id, ticket_id, "walkthrough")
        await self._orchestrator.delete_session(ticket_id)  # public API (B8)
        self._session_cache.pop(ticket_id, None)  # evict from in-process LRU

    # ── Internal helpers ──────────────────────────────────────────────────────

    # In-process LRU cache in front of the DB (B2).
    # Key: ticket_id. Value: (NormalizedTicket, GenerationResult).
    # Backed by DB so bot restarts don't lose pending approvals.
    _session_cache: dict[str, tuple] = {}  # class-level, bounded to ~100 entries

    async def _load_session(
        self,
        channel_id: str,
        ticket_id: str,
    ) -> tuple:
        """Load (ticket, generation_result) from LRU then DB. Posts error if missing."""
        from qorum.adapters.base import NormalizedTicket
        from qorum.core.plan_generator import GenerationResult

        # Fast path: in-process cache
        if ticket_id in self._session_cache:
            return self._session_cache[ticket_id]

        # Slow path: DB
        row = await self._orchestrator.load_session(ticket_id)  # public API (B8)
        if not row:
            await self.send_message(
                channel_id,
                f"Plan session for `{ticket_id}` has expired. "
                f"Run `/qorum refresh {ticket_id}` to regenerate.",
            )
            return (None, None)

        ticket = NormalizedTicket.from_json(row["ticket_json"])
        generation_result = GenerationResult.model_validate_json(row["result_json"])
        self._session_cache[ticket_id] = (ticket, generation_result)
        return (ticket, generation_result)

    async def _handle_url(
        self,
        ctx: BotContext,
        url: str,
        mode: PlanMode,
        feedback: str | None = None,
    ) -> None:
        await self.send_message(ctx.channel_id, "Fetching ticket and generating plan...")

        result = await self._orchestrator.process(url, mode=mode, feedback=feedback)

        if isinstance(result, OrchestratorError):
            msg = f"Could not process ticket: {result.message}"
            if result.recoverable:
                msg += "\n_You can retry with `/qorum <url>`._"
            await self.send_message(ctx.channel_id, msg)
            return

        # Persist session to DB + in-process cache (B2)
        await self._orchestrator.save_session(  # public API (B8)
            ticket_id=result.ticket_id,
            url=url,
            ticket=result.ticket,
            generation_result=result.generation_result,
            channel_id=ctx.channel_id,
        )
        self._session_cache[result.ticket_id] = (result.ticket, result.generation_result)

        if mode == PlanMode.BRIEF:
            await self.send_message(ctx.channel_id, result.inline_summary)
        else:
            await self.send_approval_buttons(
                ctx.channel_id,
                result.ticket_id,
                result.plan_paths,
                result.inline_summary,
            )
            await self.send_feedback_buttons(ctx.channel_id, result.ticket_id, "plan")

    async def _handle_stats(self, ctx: BotContext) -> None:
        stats = await self._orchestrator.get_stats()
        by_state = stats.get("by_state", {})
        fb = stats.get("feedback", {})
        total_fb = fb.get("total", 0)
        helpful = fb.get("helpful", 0)
        needs_work = fb.get("needs_work", 0)
        approval_rate = (
            f"{round(100 * by_state.get('DONE', 0) / stats['total_plans'])}%"
            if stats["total_plans"] else "N/A"
        )
        lines = [
            "*Qorum Team Usage Summary*\n",
            f"Total plans generated: *{stats['total_plans']}*",
            f"Completed (DONE): *{stats['completed']}*",
            f"Approval rate: *{approval_rate}*",
            "",
            "*By state:*",
        ]
        for state, count in sorted(by_state.items()):
            lines.append(f"  • {state}: {count}")
        lines += [
            "",
            f"*Feedback received:* {total_fb} total",
            f"  👍 Helpful: {helpful}  |  👎 Needs work: {needs_work}",
        ]
        if needs_work > 0:
            lines.append(
                f"\n_Use `/atlas flagged` to see plans flagged for prompt review._"
            )
        await self.send_message(ctx.channel_id, "\n".join(lines))

    async def _handle_status(self, ctx: BotContext) -> None:
        records = await self._orchestrator.list_recent(limit=10)
        if not records:
            await self.send_message(ctx.channel_id, "No plans generated yet.")
            return

        lines = ["*Recent Qorum Plans*\n"]
        for r in records:
            bar = "🟢" if r["state"] == "DONE" else ("🟡" if r["state"] == "TESTING_GENERATED" else "🔴")
            lines.append(f"{bar} `{r['ticket_id']}` — {r['state']} ({r['updated_at']})")
        await self.send_message(ctx.channel_id, "\n".join(lines))

    async def _handle_view(self, ctx: BotContext, ticket_id: str) -> None:
        if not ticket_id:
            await self.send_message(ctx.channel_id, "Usage: `/qorum view <ticket-id>`")
            return

        paths = await self._orchestrator.get_plan_paths(ticket_id)  # public API (B8)
        if not paths:
            await self.send_message(ctx.channel_id, f"No plan found for `{ticket_id}`.")
            return

        lines = [f"*Plans for `{ticket_id}`:*"]
        for p in paths:
            lines.append(f"• `{p}`")
        await self.send_message(ctx.channel_id, "\n".join(lines))

    # ── Phase 8: execute / diff-review / discard ──────────────────────────────

    async def handle_execute(
        self,
        channel_id: str,
        plan_id: str,
        plan: "Any" = None,
        locate: "Any" = None,
        classification: "Any" = None,
    ) -> None:
        """
        Start execution for an approved plan.
        plan/locate/classification may be passed directly (from Phase 7 flow)
        or will be reconstructed from session if only plan_id is provided.
        """
        from qorum.execution.runner import ExecutionRunner
        from qorum.execution.cancellation import CancellationToken, get_registry
        from qorum.bot.buttons import progress_buttons

        if plan is None or locate is None:
            await self.send_message(
                channel_id,
                f"Starting execution for `{plan_id}`...\n_Preparing branch..._",
            )
            # Future: reload plan from .quorum/ on disk. For now just report.
            await self.send_message(channel_id, "⚠ Execution from plan_id only requires Phase 11 (board integration). Pass plan object directly from Phase 7.")
            return

        if get_registry().is_active(plan_id):
            await self.send_message(channel_id, f"⚠ `{plan_id}` is already executing. Use 🛑 Stop to halt it first.")
            return

        # Register the run with the visibility server so web/VS Code can see + target it.
        self._register_run(plan_id, channel_id)

        # Cancellation token (also watched cross-process via control file).
        token = CancellationToken(plan_id, quorum_dir=getattr(locate, "plan_dir", None))
        get_registry().register(plan_id, token)

        runner = ExecutionRunner(
            plan=plan,
            plan_id=plan_id,
            locate=locate,
            agent_route=classification.agent_route if classification else [],
            work_type=classification.work_type if classification else "enhancement",
            on_event=lambda e: self._on_execution_event(plan_id, channel_id, e),
            quorum_dir=locate.plan_dir,
            config=self._config,
            cancel_token=token,
        )

        # Post a progress card with a Stop button BEFORE launching.
        msg_id = await self.send_buttons(
            channel_id,
            f"_Executing plan `{plan_id}` on branch `qorum/{plan_id[:16]}`..._",
            progress_buttons(plan_id),
        )
        self._progress_cards[plan_id] = msg_id

        # Run execution as a background task so the Stop button can be processed.
        task = asyncio.ensure_future(
            self._run_execution(channel_id, plan_id, runner, token)
        )
        self._active_executions[plan_id] = (task, token)
        get_registry().attach_task(plan_id, task)

    async def _run_execution(self, channel_id: str, plan_id: str, runner, token) -> None:
        """Background driver: run execute(), then post the result/stopped/diff card."""
        from qorum.bot.buttons import diff_review_buttons, stopped_buttons
        from qorum.execution.cancellation import get_registry

        result = None
        try:
            result = await runner.execute()
        except asyncio.CancelledError:
            # Hard fallback fired — synthesise a cancelled result if execute() didn't return one.
            await self.send_message(channel_id, f"🛑 Execution `{plan_id}` was force-stopped.")
        except Exception as exc:
            log.exception("bot.execution_error", plan_id=plan_id)
            await self.send_message(channel_id, f"⚠ Execution failed: {exc}")
        finally:
            self._active_executions.pop(plan_id, None)
            get_registry().remove(plan_id)

        if result is None:
            return

        # Store for diff-approval / discard
        self._execution_results[plan_id] = (result, runner)
        self._complete_run(plan_id, result)

        card_id = self._progress_cards.pop(plan_id, None)

        if not result.ok:
            await self.send_message(channel_id, f"⚠ Execution failed: {result.error}")
            return

        card = result.diff_card_text()
        buttons = stopped_buttons(plan_id) if result.cancelled else diff_review_buttons(plan_id)
        # Update the progress card in place if we can, else post a fresh card.
        if card_id:
            await self.edit_message(channel_id, card_id, card, buttons=buttons)
        else:
            await self.send_buttons(channel_id, card, buttons)

    async def handle_stop_execution(self, channel_id: str, plan_id: str) -> None:
        """🛑 Stop pressed — request graceful cancel, then hard-cancel after a grace period."""
        from qorum.execution.cancellation import get_registry

        entry = self._active_executions.get(plan_id)
        if not entry:
            await self.send_message(channel_id, f"_No active execution for `{plan_id}`._")
            return

        task, token = entry
        token.cancel()   # graceful — runner/harness stop at the next safe point
        self._mark_run_stopping(plan_id)
        await self.send_message(channel_id, f"🛑 Stopping `{plan_id}` — finishing the current step safely…")

        # Hard fallback: if it doesn't stop within the grace period, cancel the task.
        grace = getattr(self._config, "qorum_stop_grace_seconds", 20)
        asyncio.ensure_future(self._hard_stop_after(task, grace, plan_id))

    async def _hard_stop_after(self, task, grace: int, plan_id: str) -> None:
        try:
            await asyncio.sleep(grace)
        except asyncio.CancelledError:
            return
        if not task.done():
            log.warning("bot.execution_hard_cancel", plan_id=plan_id, grace=grace)
            task.cancel()

    async def handle_keep_branch(self, channel_id: str, plan_id: str) -> None:
        """📌 Keep branch — leave the partial work in place for manual inspection."""
        session = self._execution_results.pop(plan_id, None)
        branch = session[0].branch if session else f"qorum/{plan_id[:16]}"
        await self.send_message(
            channel_id,
            f"📌 Kept branch `{branch}` with the partial work for inspection. "
            f"Clean up with `git` when ready.",
        )

    # ── Phase 14.1: visibility-server registration (best-effort) ──────────────

    def _register_run(self, plan_id: str, channel_id: str) -> None:
        try:
            from qorum.server.runs import get_store
            get_store().create(plan_id, plan_id)
        except Exception:
            pass

    def _complete_run(self, plan_id: str, result) -> None:
        try:
            from qorum.server.runs import get_store
            get_store().complete(plan_id, result)
        except Exception:
            pass

    def _mark_run_stopping(self, plan_id: str) -> None:
        try:
            from qorum.server.runs import get_store
            get_store().mark_stopping(plan_id)
        except Exception:
            pass

    def _on_execution_event(self, plan_id: str, channel_id: str, e) -> None:
        """Fan execution events to the chat (condensed) and the visibility bus."""
        try:
            from qorum.server.event_bus import get_bus
            get_bus().publish(plan_id, e)
        except Exception:
            pass
        if e.kind in ("fs_write", "fs_edit", "fs_create", "cancelled"):
            asyncio.ensure_future(self.send_message(channel_id, f"_[{e.agent}] {e.summary}_"))

    async def handle_approve_diff(
        self,
        channel_id: str,
        plan_id: str,
        card_message_id: str,
    ) -> None:
        """Developer approved the diff — commit staged changes."""
        session = self._execution_results.pop(plan_id, None)
        if not session:
            await self.send_message(channel_id, "_No pending diff found. May have already been committed._")
            return

        result, runner = session

        # Gate guard: block commit if gate failed and not overridden
        if result.gate_result is not None and not result.gate_result.passed and not result.gate_result.overridden:
            await self.send_message(
                channel_id,
                f"❌ Cannot commit — gate failed: {result.gate_result.verdict}\n"
                f"{result.gate_result.summary}\n\n"
                f"_Fix the failing tests or use [Override commit] to proceed anyway._",
            )
            # Put the session back so the user can try again
            self._execution_results[plan_id] = session
            return

        # Phase 14: security gate guard — block on high/critical findings
        sec = result.security_result
        if sec is not None and not sec.passed and not sec.overridden:
            await self.send_message(
                channel_id,
                f"🛑 Cannot commit — security gate blocked:\n{sec.card_text()}\n\n"
                f"_Fix the findings or override (audited)._",
            )
            self._execution_results[plan_id] = session
            return

        await self.edit_message(channel_id, card_message_id, "_Committing..._")

        try:
            sha = await runner.commit_result(result)
            await self.send_message(
                channel_id,
                f"✅ Committed! SHA `{sha[:8]}` on `{result.branch}`\n\n"
                f"_No push — use `git push` or open a PR when ready._",
            )
            await self._orchestrator.append_audit_event(
                plan_id, "committed", detail={"sha": sha, "branch": result.branch}
            )
        except Exception as exc:
            # Phase 14: secrets pre-commit guard raised → surface clearly, don't commit
            from qorum.execution.git_flow import SecretsDetectedError
            if isinstance(exc, SecretsDetectedError):
                await self.send_message(
                    channel_id,
                    f"🛑 Commit blocked — secrets detected in the diff:\n"
                    + "\n".join(f"  • {f.kind} (line {f.line_no}): `{f.redacted()}`" for f in exc.findings[:5])
                    + "\n\n_Remove the secret or add it to `.qorum-secrets-allow` if it's a false positive._",
                )
                self._execution_results[plan_id] = session
            else:
                await self.send_message(channel_id, f"⚠ Commit failed: {exc}")

    async def handle_discard_diff(
        self,
        channel_id: str,
        plan_id: str,
        card_message_id: str,
    ) -> None:
        """Developer rejected the diff — discard execution branch, restore stash."""
        from qorum.execution.git_flow import discard_execution

        session = self._execution_results.pop(plan_id, None)
        if not session:
            await self.send_message(channel_id, "_No pending execution to discard._")
            return

        result, _ = session
        await self.edit_message(channel_id, card_message_id, "_Discarding..._")

        try:
            await discard_execution(result.rollback_point)
            await self.send_message(
                channel_id,
                f"↩ Execution discarded. Branch `{result.branch}` deleted; "
                f"your working tree has been restored.",
            )
            await self._orchestrator.append_audit_event(plan_id, "discarded")
        except Exception as exc:
            await self.send_message(
                channel_id,
                f"⚠ Discard failed: {exc}\n_Branch `{result.branch}` may still exist — inspect manually._",
            )

    async def _handle_map(self, ctx: BotContext, repo_path: str) -> None:
        if not repo_path:
            await self.send_message(ctx.channel_id, "Usage: `/qorum map <absolute-repo-path>`")
            return
        from pathlib import Path
        from qorum.collaboration.registry import ProjectRegistry
        p = Path(repo_path).expanduser().resolve()
        if not p.exists():
            await self.send_message(ctx.channel_id, f"Path `{p}` does not exist.")
            return
        registry = ProjectRegistry(self._config.qorum_registry_path)
        registry.add_channel_mapping(
            platform=ctx.platform,
            channel_id=ctx.channel_id,
            repo_path=p,
            label=p.name,
        )
        await self.send_message(
            ctx.channel_id,
            f"✅ This channel is now mapped to `{p}`.\n"
            f"Plans will be written to `{p / '.quorum'}`.",
        )

    async def _handle_where(self, ctx: BotContext) -> None:
        from qorum.collaboration.registry import ProjectRegistry
        registry = ProjectRegistry(self._config.qorum_registry_path)
        lines = registry.summary_lines()
        await self.send_message(ctx.channel_id, "\n".join(lines))

    async def _handle_link(self, ctx: BotContext, link_arg: str) -> None:
        """
        /qorum link <name>   → start a link; bot replies with a verification code.
        /qorum link confirm <code> → confirm ownership; registers this platform id.
        """
        from qorum.collaboration.registry import ProjectRegistry
        from qorum.bot.identity import IdentityMap

        # Resolve the target repo's .quorum dir for contributors.json
        registry = ProjectRegistry(self._config.qorum_registry_path)
        mapping = registry.find_by_channel(ctx.platform, ctx.channel_id)
        if not mapping or not mapping.repo_path:
            await self.send_message(
                ctx.channel_id,
                "This channel isn't mapped to a repo yet. Use `/qorum map <repo-path>` first.",
            )
            return

        id_map = IdentityMap(mapping.repo_path / ".quorum")
        parts = link_arg.split(maxsplit=1)

        if parts and parts[0].lower() == "confirm" and len(parts) > 1:
            code = parts[1].strip()
            contributor = id_map.confirm_link(code)
            if contributor:
                await self.send_message(
                    ctx.channel_id,
                    f"✅ Linked! `{ctx.username or ctx.user_id}` on {ctx.platform} "
                    f"is now *{contributor.name}* ({contributor.role}).",
                )
            else:
                await self.send_message(ctx.channel_id, "Invalid or expired code.")
            return

        name = link_arg.strip()
        if not name:
            await self.send_message(
                ctx.channel_id,
                "Usage: `/qorum link <your-name>` then `/qorum link confirm <code>`",
            )
            return

        code = id_map.start_link(name, ctx.platform, ctx.user_id)
        await self.send_message(
            ctx.channel_id,
            f"To link `{name}` to your {ctx.platform} account, reply with:\n"
            f"`/qorum link confirm {code}`",
        )

    async def _handle_refresh(self, ctx: BotContext, ticket_id: str) -> None:
        if not ticket_id:
            await self.send_message(ctx.channel_id, "Usage: `/qorum refresh <ticket-id>`")
            return

        # Try to reload from persisted session and re-process the original URL (B2)
        row = await self._orchestrator.load_session(ticket_id)  # public API (B8)
        if row and row.get("url"):
            await self._handle_url(ctx, row["url"], PlanMode.FULL)
        else:
            record = await self._orchestrator.get_ticket_record(ticket_id)  # public API (B8)
            if not record:
                await self.send_message(
                    ctx.channel_id,
                    f"No plan record found for `{ticket_id}`. Use `/qorum <url>` to create one.",
                )
                return
            await self.send_message(
                ctx.channel_id,
                f"To regenerate, run `/qorum <original-url>` — Qorum will overwrite the existing plan for `{ticket_id}`.",
            )
