# QUORUM Internal Testing Guide
No Azure. No deployment. Works on your machine right now.

---

## What We're Testing

```
packages/collaboration/    ← Unit tests (61 tests) ✅
apps/teams-bot/            ← Unit tests (52 tests) ✅
apps/quorum-server/         ← Integration test (manual, see Section 3)
apps/teams-bot/            ← Bot emulator test (see Section 4)
```

---

## Section 1: Run All Unit Tests

```bash
# From repo root — runs both test suites
cd packages/collaboration && npm test
cd ../apps/teams-bot && npm test

# Expected output:
# packages/collaboration: 61 passed
# apps/teams-bot:         52 passed
```

---

## Section 2: Minimum .env Setup

**apps/quorum-server/.env** (create if it doesn't exist):
```env
PORT=3001
JWT_SECRET=quorum-local-dev-secret
BOT_SECRET=test-bot-secret-123
ANTHROPIC_API_KEY=sk-ant-your-key-here
TELEGRAM_BOT_TOKEN=         # leave blank if not testing Telegram
PUBLIC_URL=http://localhost:3001
ALLOWED_ORIGINS=http://localhost:3000
```

**apps/teams-bot/.env** (create if it doesn't exist):
```env
PORT=3978
QUORUM_SERVER_URL=http://localhost:3001
BOT_SECRET=test-bot-secret-123
DEFAULT_PROJECT_DIR=D:\Atlas\QUORUM-CLAUDE
# Leave MICROSOFT_APP_ID and MICROSOFT_APP_PASSWORD blank for local testing
```

> BOT_SECRET must match in both files — it's the shared secret between the bot and the server.

---

## Section 3: Test the Collaboration API (No Bot Needed)

Start the server:
```bash
cd apps/quorum-server
npm run dev
# Should see: "QUORUM Server running on port 3001"
```

### Step 1 — Register and get a token
```bash
curl -s -X POST http://localhost:3001/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@quorum.dev","password":"atlastest123"}' | jq .

# Returns: { "token": "eyJ...", "user": {...} }
# Save the token as TOKEN=eyJ...
```

```bash
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InlCUk5OUnRVeDJaQnhsOVZxcHhjdSIsImVtYWlsIjoidGVzdEBhdGxhcy5kZXZ2IiwidHlwZSI6ImFjY2VzcyIsImlhdCI6MTc3NDY0OTUzNywiZXhwIjoxNzc0NjUzMTM3fQ.ACTtpiyLL1_peXw1sgf21DIiV4mVYVwiO42ocGlSco4"
```

### Step 2 — Initialize a project
```bash
cd D:\Atlas\QUORUM-CLAUDE
quorum init
# Creates .quorum/ folder. If quorum CLI not installed:
# npx tsx packages/cli/src/index.ts init --dir D:\Atlas\QUORUM-CLAUDE
```

### Step 3 — Create a plan from simulated chat messages
```bash
curl -s -X POST http://localhost:3001/api/collaboration/plan \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "project_dir": "D:\\Atlas\\QUORUM-CLAUDE",
    "messages": [
      {"id":"1","author":"Sarah","author_id":"u1","content":"We should add Redis caching to the API","timestamp":"2026-03-28T10:00:00Z"},
      {"id":"2","author":"Ahmed","author_id":"u2","content":"Agreed. Response times are too slow. Cache TTL should be 5 minutes","timestamp":"2026-03-28T10:01:00Z"},
      {"id":"3","author":"Sarah","author_id":"u1","content":"I will pick this up, PROJ-55","timestamp":"2026-03-28T10:02:00Z"}
    ],
    "channel_id": "test-channel",
    "platform": "teams",
    "quorum": "any"
  }' | jq .

# Returns: { plan_id, summary, plan_md, task_md, approval_status }
# Save: PLAN_ID="the-plan-id-from-response"
```

### Step 4 — Approve the plan
```bash
curl -s -X POST http://localhost:3001/api/collaboration/approve \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"plan_id\":\"$PLAN_ID\",\"project_dir\":\"D:\\\\Atlas\\\\QUORUM-CLAUDE\"}" | jq .

# Returns: { status: "approved", plan_ready: true }
```

**Verify:** Check that `.quorum/plan.md` and `.quorum/task.md` were created:
```bash
cat "D:\Atlas\QUORUM-CLAUDE\.quorum\plan.md"
cat "D:\Atlas\QUORUM-CLAUDE\.quorum\task.md"
```

### Step 5 — Create a user story
```bash
curl -s -X POST http://localhost:3001/api/collaboration/story \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "messages": [
      {"id":"1","author":"PM","author_id":"u1","content":"Users keep asking for dark mode","timestamp":"2026-03-28T10:00:00Z"},
      {"id":"2","author":"Dev","author_id":"u2","content":"Easy to add. Toggle in settings, save preference to user profile","timestamp":"2026-03-28T10:01:00Z"}
    ],
    "context_hint": "This is a settings feature for the web app"
  }' | jq .

# Returns: { story_id, story } — formatted user story ready for Jira/Linear
```

### Step 6 — List pending plans
```bash
curl -s "http://localhost:3001/api/collaboration/plans?project_dir=D:%5CAtlas%5CATLAS-CLAUDE" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

---

## Section 4: Test the Teams Bot (No Azure Needed)

### Install Bot Framework Emulator
Download: https://github.com/microsoft/BotFramework-Emulator/releases
Install the `.exe`. This replaces Teams for local testing.

### Start the bot
```bash
cd apps/teams-bot
npm run dev
# Should see: "QUORUM Teams Bot running on port 3978"
# Also: "⚠️ MICROSOFT_APP_ID not set — running in local test mode"
```

### Connect the emulator
1. Open Bot Framework Emulator
2. Click **Open Bot**
3. Bot URL: `http://localhost:3978/api/messages`
4. Leave App ID and Password blank (local mode)
5. Click **Connect**

### Test commands in the emulator

```
@QUORUM help
```
Expected: Help menu with all commands listed.

```
@QUORUM login
```
Expected: Login link message (link won't work until you add Teams auth to server, but the message should appear).

```
@QUORUM story
```
Expected: "Not enough conversation" message (no history yet).

```
We should add Redis caching to improve API response times
The cache TTL should be 5 minutes
I will pick up this ticket
@QUORUM story
```
Expected: Bot posts a formatted user story.

```
We should switch from JWT to Redis sessions
Agreed, it fixes the XSS vulnerability
Session expiry should be 7 days
I will pick up PROJ-42
@QUORUM plan
```
Expected: Bot posts an Adaptive Card with Approve/Reject buttons.

> **Note:** In the emulator, Adaptive Card buttons render. Clicking Approve calls `handleTeamsCardActionInvoke`. Since quorum-server is running, if you've linked an account, it will actually call the API.

---

## Section 5: Test the Full Flow End-to-End

This tests: Browser → quorum-server → QUORUM engine → .quorum/ memory

### Prerequisites
- quorum-server running (`npm run dev` in `apps/quorum-server/`)
- Teams bot running (`npm run dev` in `apps/teams-bot/`)
- Bot Framework Emulator connected to `http://localhost:3978/api/messages`
- `ANTHROPIC_API_KEY` set in `apps/quorum-server/.env`

### Flow

1. **Register account** via the web UI (`http://localhost:3000`) or curl (Step 3 above)

2. **Send messages in emulator:**
   ```
   We need to add rate limiting to all API endpoints
   Use express-rate-limit, 100 requests per minute per IP
   Return 429 with retry-after header when limit hit
   I will pick this up
   @QUORUM plan
   ```

3. **Bot sends Adaptive Card** — click **✅ Approve** in the emulator

4. **Watch quorum-server logs** — should see:
   ```
   POST /api/collaboration/approve
   collaboration:approved emitted
   POST /api/sessions (quorum fast triggered)
   ```

5. **Check .quorum/ folder:**
   ```bash
   cat "D:\Atlas\QUORUM-CLAUDE\.quorum\plan.md"
   cat "D:\Atlas\QUORUM-CLAUDE\.quorum\task.md"
   cat "D:\Atlas\QUORUM-CLAUDE\.quorum\collaboration\audit-trail.json"
   ```

---

## Section 6: What Each Test Covers

| Test | File | What it verifies |
|------|------|-----------------|
| Unit: approval quorum | `collaboration/__tests__/approval-manager.test.ts` | All 4 quorum modes, idempotency, expiry, rejection |
| Unit: summarizer | `collaboration/__tests__/summarizer.test.ts` | LLM prompt construction, JSON parsing, fallback on bad JSON, plan/task markdown generation |
| Unit: quorum-folder | `collaboration/__tests__/quorum-folder.test.ts` | .quorum/ directory creation, round-trip persistence, audit trail append-only, contributor upsert |
| Unit: Adaptive Cards | `teams-bot/__tests__/approval-manager-logic.test.ts` | Card JSON structure, approve/reject actions, progress states |
| Unit: bot routing | `teams-bot/__tests__/bot-routing.test.ts` | Command detection, hint extraction, card data validation, client mock contracts |

---

## Section 7: Bot Architecture — How Teams Access Works

**You asked: "We're using Chat SDK — how do we access the bot?"**

**Clarification: we used `botbuilder` (Microsoft Bot Framework), NOT the Vercel Chat SDK.**

Here is exactly how it works:

```
Local dev (now):
  Bot Framework Emulator → POST /api/messages → ATLASTeamsBot

Production (when you're ready):
  Microsoft Teams → Azure Bot Service → your public URL/api/messages → ATLASTeamsBot
                                         (use ngrok for testing)

Flow:
  1. Someone types "@QUORUM plan" in a Teams channel
  2. Teams sends the message to Azure Bot Service
  3. Azure Bot Service POSTs to https://your-server.com/api/messages
  4. Bot Framework Adapter processes it
  5. ATLASTeamsBot.onMessage() fires
  6. Bot reads channel history, calls quorum-server API
  7. quorum-server calls Claude, creates plan.md
  8. Bot posts Adaptive Card back to Teams channel
  9. Team taps Approve → Action.Execute → handleTeamsCardActionInvoke
  10. Bot calls /api/collaboration/approve
  11. quorum-server executes quorum fast
  12. Bot updates the card with progress
```

**To test with real Teams (when ready):**
```bash
# 1. Get a public URL
ngrok http 3978

# 2. Register a bot on Azure
#    portal.azure.com → Bot Services → New → Web App Bot
#    Messaging endpoint: https://your-ngrok-url/api/messages

# 3. Add app ID + password to .env
MICROSOFT_APP_ID=from-azure-portal
MICROSOFT_APP_PASSWORD=from-azure-portal

# 4. Install your bot in Teams
#    Teams Admin Center → Apps → Upload custom app → manifest.zip
```

**For Slack/Discord:** The Chat SDK idea from the plan is still valid for the future.
When you're ready, create `apps/quorum-bot/` as a unified bot using the Vercel AI SDK
that replaces `apps/teams-bot/` and `apps/telegram-bot/` with one codebase.

---

## Section 8: What We Still Need To Do

```
✅ Done now:
  packages/collaboration/    — core logic + 61 tests
  apps/teams-bot/            — Teams bot + 52 tests
  apps/quorum-server/         — collaboration routes (plan/approve/reject/story)
  agents/quorum-summarizer.md — new agent
  agents/quorum-story-writer.md — new agent

🔜 Next:
  1. Wire quorum fast command trigger (after approval, execute actually runs)
     → Test: approve a plan, watch .quorum/ get updated by the CLI
  2. Add progress streaming back to Teams channel
     → Socket.IO session:event → bot sends progress card updates
  3. PM tool adapters (Linear/Jira/Azure Boards)
     → quorum watch command watches for [QUORUM] keyword
  4. Slack bot (extend with Chat SDK or separate bolt app)
  5. Cost optimizer commands (quorum cost-plan, quorum scale-plan)
```
