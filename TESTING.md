# QUORUM Local Testing Guide

## What's Running

| Service | URL | Status |
|---------|-----|--------|
| quorum-server (API + Socket.IO) | http://localhost:3001 | Start with `npm run dev` in `apps/quorum-server/` |
| quorum-web (React dashboard) | http://localhost:3000 | Start with `npx vite` in `apps/quorum-web/` |

**Starting both (do in this order):**
```bash
# If you see EADDRINUSE errors, kill stale node processes first:
# PowerShell:
Get-NetTCPConnection -LocalPort 3000,3001 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }

# Terminal 1 — Start server FIRST
cd apps/quorum-server
npm run dev

# Terminal 2 — Start web AFTER (once server shows "running on port 3001")
cd apps/quorum-web
npx vite --port 3000 --strictPort
```

> `--strictPort` makes Vite fail loudly if 3000 is taken, so it can never accidentally steal port 3001 and create a proxy loop.

---

## How to Test the Web Terminal

1. Go to http://localhost:3000, log in
2. Click **▶ Run Command** in the header
3. Select a command (`quorum doctor` is the quickest — no AI key needed)
4. Fill in the project directory (e.g. `D:\Atlas\QUORUM-CLAUDE`)
5. Check `--auto` to skip checkpoints
6. Click **▶ Run** — you'll see live terminal output streamed via Socket.IO

> **Note:** Commands that need AI (like `quorum new`) require an API key. Go to the **API Keys** page first and save your `ANTHROPIC_API_KEY` (or whichever provider you use).

---

## How to Test the Telegram Bot

1. **Create a bot** — message [@BotFather](https://t.me/BotFather) on Telegram:
   ```
   /newbot
   ```
   Follow prompts → get your token like: `7123456789:AAFxxxxxxxxxxxxxxxx`

2. **Set token in .env** — edit `apps/quorum-server/.env`:
   ```
   TELEGRAM_BOT_TOKEN=7123456789:AAFxxxxxxxxxxxxxxxx
   PUBLIC_URL=http://localhost:3001
   ```

3. **Restart the server** — you should see:
   ```
   QUORUM Telegram Bot started
   QUORUM Server running on port 3001
   ```

4. **Test the bot** — open Telegram, find your bot and send:
   ```
   /start      ← shows help menu
   /login      ← bot sends a link: http://localhost:3001/api/auth/telegram/link?token=xxx
   ```

5. **Link your account** — open the link in a browser where you're already logged into QUORUM Console. If you're not logged in, log in first then revisit the link.

6. **Test from Telegram:**
   ```
   /status     ← shows latest session
   /stop       ← interrupts running session
   ```

> **For public testing:** You need a public URL. Use [ngrok](https://ngrok.com):
> ```bash
> ngrok http 3001
> ```
> Then set `PUBLIC_URL=https://your-ngrok-url.ngrok.io` in `.env`.

---

## How to Test the Mobile App (quorum-console)

### Prerequisites
- Install [Expo Go](https://expo.dev/go) on your iPhone or Android phone
- Phone must be on the **same WiFi network** as your dev machine

### Steps

1. **Install deps:**
   ```bash
   cd apps/quorum-console
   npx expo install
   ```

2. **Set server URL** — create `apps/quorum-console/.env`:
   ```
   EXPO_PUBLIC_QUORUM_SERVER=http://YOUR_MACHINE_IP:3001
   ```
   Find your IP: `ipconfig` → look for IPv4 Address (e.g. `192.168.1.5`)

3. **Start Expo:**
   ```bash
   npx expo start
   ```

4. **On your phone:**
   - Open Expo Go
   - Scan the QR code shown in terminal
   - The QUORUM Console app loads

5. **Log in** with `test@quorum.dev` / `atlastest123`

6. **Run a command:**
   - Tap the terminal input at the bottom
   - Type: `quorum doctor "D:\\Atlas\\QUORUM-CLAUDE"`
   - Watch live output stream

7. **Test Telegram link from mobile:**
   - Go to Settings tab
   - Tap the Telegram section
   - This generates a linking flow

---

## How to Add a New AI Provider (Future)

The API key system now accepts **any** UPPER_CASE env var string. On the API Keys page:

1. Click **"+ Add a different provider"**
2. Type the env var name (e.g. `TOGETHER_API_KEY`, `OLLAMA_BASE_URL`, `XAI_API_KEY`, `COHERE_API_KEY`)
3. The key gets stored AES-256 encrypted and injected into your sessions automatically

**No code change needed** — the server accepts any `^[A-Z0-9_]+$` string.
