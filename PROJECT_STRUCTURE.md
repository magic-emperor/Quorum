# QUORUM-CLAUDE: Complete Project Structure & Details

## Overview
**QUORUM-CLAUDE (Autonomous Team for Large-scale Application Systems)** is a multi-agent AI framework designed to build applications end-to-end autonomously. It features persistent memory, 14 coordinated agents, and multiple interfaces (CLI, MCP, VS Code, Mobile, Telegram).

This document serves as a comprehensive guide to understanding the complete repository structure, detailing what each folder and file does, why it exists, and the major concepts driving the system.

---

## High-Level Repository Structure

The project uses a monorepo structure. Here is the high-level breakdown:

```text
QUORUM-CLAUDE/
├── agents/            # Prompts and instructions for the 14 AI agents
├── apps/              # Full-stack applications (Server, Web Dashboard, Mobile App, Bot)
├── commands/          # Legacy or specific slash command definitions
├── packages/          # Core modules: Engine, CLI, MCP Server, VS Code Extension
├── skills/            # Specialized skill definitions for autonomous tasks
└── [Root Files]       # Configuration, documentation, and Docker setup
```

---

## Detailed Breakdown

### 1. Root Files
These files govern the overall configuration, alignment, and deployment of the framework.

- **`QUORUM-MASTER-ALIGNMENT.md`**: The master source of truth for the project. Outlines the 3 core rules (Model agnostic, Memory persistent, Human in control), build orders, and what the project fundamentally is. *Read this before modifying the codebase.*
- **`README.md` & `QUORUM-QUICKSTART.md`**: Onboarding guides. The quickstart provides fast setup instructions, while the README explains the 25+ CLI commands, architecture, and core differences from other AI coding tools.
- **`AGENTS.md`**: Details the purpose, triggers, and loops of the 14 specialized AI agents (e.g., Critic, Backend Architect, Orchestrator).
- **`package.json`**: The npm monorepo configuration utilizing `"workspaces": ["packages/*"]` to manage dependencies across `core`, `cli`, `mcp`, and `vscode`.
- **`docker-compose.yml` & `.env.example`**: Deployment configurations. Spns up the backend server (`quorum-server`) and its dependencies.
- **`quorum.config.json`**: The central configuration file mapping which AI providers (Anthropic, OpenAI, Google, Groq, local models) to use.

---

### 2. `packages/` (The Core Monorepo Packages)
This folder holds the standalone logic that powers the entire ecosystem.

#### `packages/core/` (The Engine)
This is the brain of QUORUM. It handles all commands, routing, memory, and task execution.
- **`src/engine.ts`**: The main `ATLASEngine` class. It wires together all 25 CLI commands and orchestrates the entire system.
- **`src/agent-runner.ts`**: Reads agent `.md` instruction files and routes them to the appropriate API (Anthropic, OpenAI, etc.).
- **`src/tool-executor.ts`**: Implements file system and terminal tools (e.g., file read/write, bash execution, regex search).
- **`src/types.ts` & `src/config.ts`**: Global TypeScript definitions and configuration loaders.
- **`src/providers/`**: Adapters for every supported AI model. Includes `anthropic.ts`, `openai.ts`, `google.ts`, `local.ts` (Ollama), and dynamic model discovery (`discover.ts`). This ensures the system remains model-agnostic.
- **`src/memory/`**: The most crucial part of QUORUM's persistence:
  - `nervous-system.ts`: Manages the `.quorum/` folder in target projects.
  - `task-manager.ts` & `plan-manager.ts`: Handles task CRUD and surgical plan updates.
  - `goal-guardian.ts`: Prevents scope creep by enforcing rules in `goal.md`.
  - `function-registry.ts`: Maintains a map of all codebase functions, reducing navigation costs by 98.8%.
- **`src/testing/`**: Handles automated end-to-end browser testing (via Playwright) and automatic test generation based on QUORUM's memory.
- **`src/commands/`**: Contains the logic for the 25+ CLI commands (e.g., `init`, `new`, `verify`, `ship`, `sync`, `debug`).

#### `packages/cli/`
- **`src/index.ts`**: The command-line interface entry point. It parses input flags and routes them to the `ATLASEngine` in `packages/core`.

#### `packages/mcp/`
- **`src/server.ts`**: Exposes QUORUM as a Model Context Protocol (MCP) server. Provides 14 tools (like `quorum_new`, `quorum_functions`, `quorum_debug`) so QUORUM can act as a tool inside Claude Desktop, remote Cursor, etc.

#### `packages/vscode/`
- Contains the VS Code Extension logic (Phase 5). This will integrate QUORUM natively into the IDE sidebar and code panels.

---

### 3. `apps/` (The Platform Applications)
These apps provide UI and external interfaces for interacting with the QUORUM engine.

- **`quorum-server/`**: The core backend API (Express + Socket.IO) utilizing a local SQLite database (`quorum.db`, `quorum.db-wal`). It handles session running (`session-runner.ts`) and telemetry/tracking for long-running AI tasks.
- **`quorum-web/`**: A React + Vite web dashboard (`src/main.tsx`, `index.html`) used to monitor active agents, visualize project memory, and handle user checkpoints.
- **`quorum-console/`**: A React Native (Expo) mobile application to view and monitor agent progress on the go (`app/(auth)/login.tsx`, `lib/socket.ts`).
- **`telegram-bot/`**: A standalone Node.js Telegram bot (`src/bot.ts`, `src/api.ts`) that sends developers real-time notifications about their background QUORUM builds and requests manual approvals.

---

### 4. `agents/` (The AI System Personas)
System prompt `.md` files that define each of the 14 agents. The Orchestrator routes tasks to them.
- **`quorum-orchestrator.md`**: Master coordinator that dispatches work based on phases.
- **`quorum-classifier.md`**: Detects if a task is simple or complex to route pipelines.
- **`quorum-critic.md`**: An evidence-only interceptor. Every claim made by other agents passes through Critic to ensure no blind assumptions are made.
- **`quorum-backend-architect.md` & `quorum-backend-validator.md`**: Phase 1 pair. The Architect builds the system design, the Validator challenges it until they reach 100% mutual confidence.
- **`quorum-design-architect.md` & `quorum-design-validator.md`**: Designs UI/UX with visual variations and verifies technical feasibility.
- **`quorum-frontend-builder.md`, `quorum-testing.md`, `quorum-scaling.md`**: Execution-focused agents for writing React, running E2E tests, and checking bottleneck costs.
- **`quorum-nervous-system.md`**, **`quorum-task-manager.md`**, **`quorum-planner.md`**: Memory maintainers that cleanly update the `.quorum/` folder.

---

### 5. `skills/` (Specialized Instructions)
Skills are structured markdown rules passed to agents contextually when specific actions are needed.
- **`quorum-function-registry/`**: Teaches agents how to query the function registry instead of blindly reading huge files.
- **`quorum-project-memory/`**: Teaches agents how to read and write surgical updates to the `.quorum/` memory files.
- **`quorum-loop-prevention/`**: Rules to prevent infinite confidence loops between architects and validators.
- **`quorum-foundation-mode/`**: Used strictly when initializing a new codebase from scratch.

---

## Major Concepts & Why They Exist

### The Persistent Memory System (`.quorum/` in Target Projects)
When you run `quorum init` in a new project, it creates an `.quorum/` folder. This lives in the user's project repository.
- **Why?**: Regular AI context resets every session. The `.quorum/` folder maintains permanent project memory (actions, decisions, bugs, architecture) so the AI never needs functionality re-explained.
- **Major Files within `.quorum/`**:
  - `goal.md`: Human-approved guardrails.
  - `task.md` & `plan.md`: The active building checklist.
  - `nervous-system/function-registry.json`: Maps every function and caller in the repo.
  - `nervous-system/decisions.json`: Explains *why* architectural decisions were made.
  - `BUGS.md`: A permanent registry of previous fixes so agents never repeat them.

### Function Registry Cost-Saving
- **Why?**: Instead of making the AI read 15,000 lines of code across 3 files just to find how a function is called, QUORUM uses `quorum sync` to index functions. The bot reads `function-registry.json` (200 tokens) to find exactly where to look, making navigation **98.8% cheaper**.

### Human-in-the-Loop Checkpoints
- **Why?**: AI frequently hallucinates or takes the wrong approach entirely. QUORUM uses 3 strict checkpoints:
  1. Architecture approval.
  2. UI/Design approval.
  3. Acceptance Testing approval.
  No code is written until the human approves Phase 1 and 2.

### Model Router Agnosticism
- **Why?**: Provider locks are bad. The `model-router` (`packages/core/src/providers/index.ts`) allows instant swapping between Anthropic Claude, OpenAI, Google Gemini, Groq, DeepSeek, and local Ollama without modifying agent logic.

---

*This document is intended to help developers, technical colleagues, and new contributors understand where logic resides and the core philosophy behind the framework.*
