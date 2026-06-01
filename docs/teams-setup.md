# Microsoft Teams Setup — Qorum

## Prerequisites
- Azure subscription with access to create Bot Service resources
- Microsoft 365 / Teams admin account (or dev tenant from M365 Dev Program)
- Qorum visibility server running at a public HTTPS URL

## Step 1 — Azure Bot Service registration

1. Go to [Azure Portal](https://portal.azure.com) → **Create a resource** → **Azure Bot**
2. Fill in:
   - **Bot handle**: `qorum-bot` (or your preferred name)
   - **Type**: Multi-tenant (or Single-tenant if restricting to one org)
   - **Messaging endpoint**: `https://<your-host>/api/messages`
3. After creation, go to **Configuration** and note:
   - **Microsoft App ID** → `QORUM_TEAMS_APP_ID`
4. Go to **Manage** (or the linked App Registration) → **Certificates & secrets** → **New client secret**
   - Copy the secret value → `QORUM_TEAMS_APP_PASSWORD`

## Step 2 — Configure Qorum

Add to your `.env`:

```env
QORUM_TEAMS_APP_ID=<your-app-id-guid>
QORUM_TEAMS_APP_PASSWORD=<your-client-secret>
QORUM_TEAMS_TENANT_ID=<your-tenant-id>  # optional, single-tenant only
```

## Step 3 — Start Qorum with Teams

```bash
# Start both the visibility server and the Teams bot:
qorum serve &
qorum bot --platform teams
```

Or all platforms:

```bash
qorum bot --platform all
```

## Step 4 — Build and sideload the Teams app

1. Copy `apps/teams-manifest/` to a working directory
2. Replace placeholder values in `manifest.json`:
   - `$QORUM_TEAMS_APP_ID` → your App ID from Step 1
   - `$QORUM_SERVER_HOST` → your server hostname (e.g. `myserver.ngrok.io`)
3. Add placeholder icons (`outline.png` 32×32, `color.png` 192×192 — any PNG for dev)
4. Zip the folder: `zip -j qorum-app.zip manifest.json outline.png color.png`
5. In Teams: **Apps** → **Manage your apps** → **Upload a custom app** → select the zip

## Step 5 — Local development (dev tunnel)

For local testing without a public server:

```bash
# VS Code Dev Tunnels (recommended):
# 1. Install VS Code Dev Tunnels extension
# 2. Create a tunnel: Ctrl+Shift+P → "Dev Tunnels: Create Tunnel"
# 3. Use the tunnel URL as your messaging endpoint in Step 1

# Or ngrok:
ngrok http 7432
# Use the https:// URL as your messaging endpoint
```

## Step 6 — Test with Bot Framework Emulator

1. Download [Bot Framework Emulator](https://github.com/microsoft/BotFramework-Emulator)
2. Connect to `http://localhost:7432/api/messages`
3. Enter your App ID and App Password
4. Type `@Qorum plan this feature` to trigger the boundary engine

## Permissions required (Graph API — for thread history)

Optional — only needed if you want Teams thread history beyond the rolling buffer:

| Permission | Type | Reason |
|---|---|---|
| `ChannelMessage.Read.All` | Application | Read channel messages for thread context |
| `Chat.Read.All` | Application | Read chat messages |

Grant via Azure Portal → App Registration → API Permissions → Add permission → Microsoft Graph.

## Quorum rules for Teams approvals

Create `.quorum/collaboration/contributors.json` in your target repo:

```json
[
  {
    "name": "Alice Smith",
    "email": "alice@company.com",
    "is_lead": true,
    "platforms": {
      "teams_id": "<alice-aad-object-id>"
    }
  }
]
```

Find a user's AAD object ID in Azure AD → Users → select user → Object ID.

## Troubleshooting

| Issue | Fix |
|---|---|
| Bot not responding | Check messaging endpoint is reachable; verify App ID/Password in `.env` |
| Approval card not appearing | Ensure Adaptive Card v1.5 is enabled in your Teams tenant |
| Invoke activity timeout | Qorum acks within 200ms; verify the server is fast enough |
| "Tenant not found" | Add `QORUM_TEAMS_TENANT_ID` or set bot to Multi-tenant |
