# AI Onboarding & Instructions Prompt

If you are instructing another AI (like Cursor, Claude, GPT-4, or Windsurf) to work on the **QUORUM-CLAUDE** project, provide them with the following prompt to ensure they understand the repository, rules, and architecture before writing any code.

---

**Copy and paste everything below this line to the AI:**

📋 **System Prompt / Task Instructions for QUORUM-CLAUDE Development**

You are working on **QUORUM-CLAUDE**, a multi-agent AI framework that builds applications end-to-end autonomously with persistent memory and 14 specialized agents. This is a complex TypeScript monorepo.

### 🌟 Project Vision & Goal
Our ultimate goal is to create the absolute best AI development framework out there by combining everything flawlessly and innovatively. Do not settle for "good enough" or standard boilerplate—aim for perfection, exceptional robustness, and industry-leading architecture in every change you propose or make. We aren't just building a tool; we are building the absolute best.

Before you write or modify any code, you MUST adhere to the following strict guidelines:

### 1. Mandatory Reading
Before proposing any architectural changes, read `QUORUM-MASTER-ALIGNMENT.md` in the root directory. This is the master alignment document—it explains the build order, the 14 agents, and the exact tools in the ecosystem.

### 2. The 3 Immutable Repository Rules
- **Rule 1: Model Agnostic First.** Every AI call goes through the model-router (`packages/core/src/providers/index.ts`). You must NEVER hardcode a specific provider (like Anthropic or OpenAI) outside of the `providers/` directory. If you see hardcoded models, fix them.
- **Rule 2: Memory Persistent Always.** You must route state changes to the target project's `.quorum/` folder via the Nervous System (`packages/core/src/memory/nervous-system.ts`). Persistent context must survive session resets.
- **Rule 3: Human in Control.** There are three human checkpoints (Architecture, Design, Testing). The engine must never auto-proceed without explicit approval gates.

### 3. Code Navigation (CRITICAL FOR TOKEN SAVINGS)
Do not aggressively glob or read large files blindly. This repository utilizes a custom **Function Registry**:
- Use `function-registry.json` to find where functions and callers are defined.
- Query this registry to understand usage graphs, which reduces navigation token costs by 98.8%. 

### 4. Monorepo Architecture Context
- **`packages/core/`**: The ATLASEngine. Core logic, memory systems, agents routing, browser testing, and model switching.
- **`packages/cli/`**: CLI entry points for all 25+ commands.
- **`packages/mcp/`**: Model Context Protocol integration offering 14 tools to run QUORUM from Claude Desktop.
- **`apps/`**: Interfaces connecting to the engine (`quorum-server` for the backend DB/sockets, `quorum-web` dashboard, `quorum-console` mobile app, `telegram-bot` for notifications).
- **`agents/` & `skills/`**: Markdown prompt definitions for AI personas and precise sub-routines (like "loop-prevention").

### 5. Execution Protocol
Whenever I give you a task:
1. Explain your execution plan briefly.
2. Outline exactly which packages/files will be affected.
3. Keep your changes targeted. Do not rewrite boilerplate or modify `QUORUM-MASTER-ALIGNMENT.md` unless explicitly requested.

Now, wait for my specific task.
