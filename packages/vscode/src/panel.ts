import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'

interface WebviewMessage {
  type: string
  command?: string
  description?: string
  subcommand?: string
}

/**
 * Sidebar WebviewView panel — the main ATLAS UI in the activity bar.
 * Shows project state, quick actions, session info.
 * Communicates with the extension host via postMessage.
 */
export class ATLASPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'atlas.panel'

  private view?: vscode.WebviewView
  private onCommandCallback?: (command: string, description?: string, subcommand?: string) => void

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly projectDir: string
  ) {}

  onCommand(cb: (command: string, description?: string, subcommand?: string) => void): void {
    this.onCommandCallback = cb
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    }

    webviewView.webview.html = this.getHtml(webviewView.webview)

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage((data: WebviewMessage) => {
      if (data.type === 'command') {
        this.onCommandCallback?.(data.command ?? '', data.description, data.subcommand)
      }
    })

    // Send initial state
    this.refresh()
  }

  /** Push updated state into the webview */
  refresh(): void {
    if (!this.view) return

    const atlasDir = path.join(this.projectDir, '.atlas')
    const initialized = fs.existsSync(atlasDir)
    let taskSummary = 'No tasks yet'
    let goal = 'No goal defined'

    if (initialized) {
      const goalPath = path.join(atlasDir, 'goal.md')
      if (fs.existsSync(goalPath)) {
        const goalContent = fs.readFileSync(goalPath, 'utf-8')
        goal = goalContent.split('\n').find(l => l.trim() && !l.startsWith('#')) ?? goal
        if (goal.length > 80) goal = goal.slice(0, 77) + '...'
      }

      const taskIndexPath = path.join(atlasDir, 'task-index.json')
      if (fs.existsSync(taskIndexPath)) {
        try {
          const idx = JSON.parse(fs.readFileSync(taskIndexPath, 'utf-8')) as {
            total: number
            summary: { complete: number; in_progress: number; blocked: number }
          }
          taskSummary = `${idx.summary.complete}/${idx.total} complete, ${idx.summary.in_progress} in progress`
        } catch { /* use default */ }
      }
    }

    void this.view.webview.postMessage({
      type: 'state',
      initialized,
      goal,
      taskSummary,
      projectDir: this.projectDir
    })
  }

  postMessage(msg: unknown): void {
    this.view?.webview.postMessage(msg)
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce()

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ATLAS</title>
  <style nonce="${nonce}">
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 8px;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 4px;
      border-bottom: 1px solid var(--vscode-panel-border);
      margin-bottom: 12px;
    }
    .header h2 {
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.05em;
      color: var(--vscode-foreground);
    }
    .badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 10px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .section { margin-bottom: 16px; }
    .section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
    }
    .info-card {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      padding: 8px;
      font-size: 12px;
      line-height: 1.5;
    }
    .info-card .label {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      margin-bottom: 2px;
    }
    .info-card .value {
      color: var(--vscode-foreground);
      word-break: break-word;
    }
    .btn-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px;
    }
    .btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding: 6px 8px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-size: 12px;
      font-family: inherit;
      transition: background 0.1s;
      white-space: nowrap;
    }
    .btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .btn.primary {
      grid-column: 1 / -1;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .btn.primary:hover { background: var(--vscode-button-hoverBackground); }
    .status-line {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      padding: 4px 0;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .dot.green { color: #4caf50; }
    .dot.grey { color: var(--vscode-descriptionForeground); }
    .log {
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      white-space: pre-wrap;
      word-break: break-all;
      color: var(--vscode-terminal-foreground, var(--vscode-foreground));
      background: var(--vscode-terminal-background, var(--vscode-editor-background));
      border-radius: 4px;
      padding: 6px;
      max-height: 120px;
      overflow-y: auto;
      margin-top: 4px;
    }
    #not-initialized { display: none; }
  </style>
</head>
<body>
  <div class="header">
    <h2>ATLAS</h2>
    <span class="badge" id="badge">loading...</span>
  </div>

  <!-- Not initialized state -->
  <div id="not-initialized" class="section">
    <div class="info-card">
      <div class="label">Project not initialized</div>
      <div class="value">Run ATLAS: Initialize Project to set up .atlas/ and define your goal.</div>
    </div>
    <br>
    <button class="btn primary" onclick="send('init')">Initialize Project</button>
  </div>

  <!-- Initialized state -->
  <div id="initialized" class="section">
    <div class="section">
      <div class="section-title">Goal</div>
      <div class="info-card">
        <div class="value" id="goal-text">Loading...</div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Tasks</div>
      <div class="info-card">
        <div class="value" id="task-summary">Loading...</div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Quick Actions</div>
      <div class="btn-grid">
        <button class="btn primary" onclick="sendWithInput('new', 'What do you want to build?')">+ New Feature</button>
        <button class="btn" onclick="send('next')">What's Next</button>
        <button class="btn" onclick="sendWithInput('enhance', 'What do you want to enhance?')">Enhance</button>
        <button class="btn" onclick="sendWithInput('fast', 'Quick task description?')">Fast Task</button>
        <button class="btn" onclick="send('doctor')">Doctor</button>
        <button class="btn" onclick="send('status')">Status</button>
        <button class="btn" onclick="send('verify')">Verify</button>
        <button class="btn" onclick="send('session-report')">Session Report</button>
        <button class="btn" onclick="sendWithInput('debug', 'Describe the bug or error')">Debug</button>
        <button class="btn" onclick="send('review')">Review</button>
        <button class="btn" onclick="send('map')">Map Codebase</button>
        <button class="btn" onclick="send('ship')">Ship (PR)</button>
      </div>
    </div>

    <div class="section" id="log-section" style="display:none">
      <div class="section-title">Output</div>
      <div class="log" id="log"></div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi()

    function send(command, description, subcommand) {
      vscode.postMessage({ type: 'command', command, description, subcommand })
    }

    async function sendWithInput(command, placeholder) {
      // We can't show input boxes in the webview, so we ask the extension host
      vscode.postMessage({ type: 'command', command, description: '__prompt__:' + placeholder })
    }

    window.addEventListener('message', event => {
      const msg = event.data
      if (msg.type === 'state') {
        document.getElementById('badge').textContent = msg.initialized ? 'ready' : 'not init'
        document.getElementById('not-initialized').style.display = msg.initialized ? 'none' : 'block'
        document.getElementById('initialized').style.display = msg.initialized ? 'block' : 'none'
        if (msg.initialized) {
          document.getElementById('goal-text').textContent = msg.goal
          document.getElementById('task-summary').textContent = msg.taskSummary
        }
      } else if (msg.type === 'log') {
        const logSection = document.getElementById('log-section')
        const log = document.getElementById('log')
        logSection.style.display = 'block'
        log.textContent += msg.line + '\\n'
        log.scrollTop = log.scrollHeight
      } else if (msg.type === 'done') {
        // Refresh state after command
        setTimeout(() => vscode.postMessage({ type: 'command', command: '__refresh__' }), 500)
      }
    })
  </script>
</body>
</html>`
  }
}

function getNonce(): string {
  let text = ''
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length))
  }
  return text
}
