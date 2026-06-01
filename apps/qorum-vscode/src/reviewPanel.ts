/**
 * Review panel — webview showing diff + approve/discard controls.
 * Opens when execution completes.
 */
import * as vscode from 'vscode';
import { QorumClient } from './client';

export class ReviewPanel {
    private static _current: ReviewPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;

    static show(extensionUri: vscode.Uri, client: QorumClient, runId: string): void {
        if (ReviewPanel._current) {
            ReviewPanel._current._panel.reveal();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'qorumReview',
            `Qorum Review — ${runId}`,
            vscode.ViewColumn.Beside,
            { enableScripts: true },
        );
        ReviewPanel._current = new ReviewPanel(panel, client, runId);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly client: QorumClient,
        runId: string,
    ) {
        this._panel = panel;
        panel.onDidDispose(() => { ReviewPanel._current = undefined; });

        // Load diff async and render
        this._loadAndRender(runId);

        // Handle messages from webview
        panel.webview.onDidReceiveMessage(async msg => {
            if (msg.command === 'approve') {
                const ok = await client.approveDiff();
                panel.webview.postMessage({ command: 'approved', ok });
            } else if (msg.command === 'discard') {
                await client.discard();
                panel.dispose();
            }
        });
    }

    private async _loadAndRender(runId: string): Promise<void> {
        const data = await this.client.getDiff(runId);
        const diffLines = (data.diff || '').split('\n').map(line => {
            if (line.startsWith('+') && !line.startsWith('+++')) {
                return `<span class="add">${esc(line)}</span>`;
            }
            if (line.startsWith('-') && !line.startsWith('---')) {
                return `<span class="del">${esc(line)}</span>`;
            }
            return esc(line);
        }).join('\n');

        const changeLogHtml = (data.change_log as Array<Record<string, string>>)
            .map(e => `<tr><td><code>${esc(e.path)}</code></td><td>${e.action}</td><td>+${e.lines_added}/-${e.lines_removed}</td><td>${esc(e.reason || '')}</td></tr>`)
            .join('');

        this._panel.webview.html = `<!DOCTYPE html><html><head>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); padding: 1rem; }
  pre  { background: var(--vscode-textCodeBlock-background); padding: 1rem; overflow-x: auto; font-size: .8rem; }
  .add { color: var(--vscode-gitDecoration-addedResourceForeground); }
  .del { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  table { border-collapse: collapse; width: 100%; margin-bottom: 1rem; }
  th, td { text-align: left; padding: .3rem .6rem; border-bottom: 1px solid var(--vscode-panel-border); }
  button { padding: .5rem 1rem; margin-right: .5rem; border: none; border-radius: 4px; cursor: pointer; }
  #btn-approve { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  #btn-discard { background: var(--vscode-errorForeground); color: #fff; }
  #status { margin-top: 1rem; }
</style>
</head><body>
<h2>Diff Review — ${runId}</h2>
<h3>Changed Files</h3>
<table><tr><th>Path</th><th>Action</th><th>Lines</th><th>Reason</th></tr>${changeLogHtml}</table>
<pre>${diffLines}</pre>
<div>
  <button id="btn-approve">✅ Approve diff → commit</button>
  <button id="btn-discard">↩ Discard</button>
</div>
<div id="status"></div>
<script>
  const vscode = acquireVsCodeApi();
  document.getElementById('btn-approve').onclick = () => {
    document.getElementById('status').textContent = 'Committing…';
    vscode.postMessage({ command: 'approve' });
  };
  document.getElementById('btn-discard').onclick = () => vscode.postMessage({ command: 'discard' });
  window.addEventListener('message', e => {
    if (e.data.command === 'approved') {
      document.getElementById('status').textContent = e.data.ok ? '✅ Committed!' : '❌ Failed — check gate results.';
    }
  });
</script>
</body></html>`;
    }
}

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
