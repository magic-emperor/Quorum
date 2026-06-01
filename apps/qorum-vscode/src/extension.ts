/**
 * Qorum VS Code Extension — Phase 10
 *
 * Features:
 *  - Activity tree: changed files grouped by agent, updating live via WS
 *  - Auto-reveal: open file + diff (base vs working tree) as agent edits
 *  - Status bar: "Qorum: editing auth.py · build ✓ · tests 12/14"
 *  - Review panel: Approve diff → commit / Discard / Open dashboard
 */
import * as vscode from 'vscode';
import { QorumActivityProvider, ActivityNode } from './activityTree';
import { QorumClient } from './client';
import { StatusBar } from './statusBar';
import { ReviewPanel } from './reviewPanel';

let client: QorumClient | undefined;
let statusBar: StatusBar | undefined;

export function activate(context: vscode.ExtensionContext) {
    const activityProvider = new QorumActivityProvider();
    statusBar = new StatusBar();

    vscode.window.registerTreeDataProvider('qorumActivityTree', activityProvider);

    // ── Commands ──────────────────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('qorum.connectRun', async () => {
            const runId = await vscode.window.showInputBox({
                prompt: 'Enter run ID (from Qorum chat message)',
                placeHolder: 'e.g. plan-abc123',
            });
            if (!runId) return;
            connectToRun(context, runId, activityProvider);
        }),

        vscode.commands.registerCommand('qorum.showDashboard', () => {
            const cfg = vscode.workspace.getConfiguration('qorum');
            const url = cfg.get<string>('serverUrl', 'http://127.0.0.1:7432');
            vscode.env.openExternal(vscode.Uri.parse(url));
        }),

        vscode.commands.registerCommand('qorum.approveDiff', async () => {
            if (!client) { vscode.window.showWarningMessage('No active Qorum run.'); return; }
            const ok = await client.approveDiff();
            if (ok) {
                vscode.window.showInformationMessage('✅ Diff approved — commit created on branch.');
                statusBar?.update('approved');
            } else {
                vscode.window.showErrorMessage('Approval failed — check gate results.');
            }
        }),

        vscode.commands.registerCommand('qorum.discardRun', async () => {
            if (!client) return;
            const confirm = await vscode.window.showWarningMessage(
                'Discard this execution? The branch will be deleted.',
                'Discard', 'Cancel'
            );
            if (confirm === 'Discard') {
                await client.discard();
                statusBar?.update('discarded');
                vscode.window.showInformationMessage('↩ Execution discarded.');
            }
        }),

        vscode.commands.registerCommand('qorum.stopExecution', async () => {
            if (!client) { vscode.window.showWarningMessage('No active Qorum run.'); return; }
            const ok = await client.stop();
            if (ok) {
                vscode.window.showInformationMessage('🛑 Stop requested — halting at the next safe point.');
            } else {
                vscode.window.showErrorMessage('Could not request stop (no active run).');
            }
        }),
    );

    // Auto-connect if a run_id is in the URL handler
    vscode.window.onDidChangeActiveTextEditor(() => { /* future: deep link */ });

    statusBar.update('idle');
}

async function connectToRun(
    context: vscode.ExtensionContext,
    runId: string,
    activityProvider: QorumActivityProvider,
) {
    const cfg = vscode.workspace.getConfiguration('qorum');
    const serverUrl = cfg.get<string>('serverUrl', 'http://127.0.0.1:7432');
    const token = cfg.get<string>('token', '');
    const autoReveal = cfg.get<boolean>('autoRevealFile', true);

    client = new QorumClient(serverUrl, token);

    vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Qorum: connecting to run ${runId}…`, cancellable: true },
        async (progress, cancel) => {
            statusBar?.update('connecting');

            client!.onEvent(event => {
                activityProvider.addEvent(event);
                statusBar?.handleEvent(event);

                if (autoReveal && (event.kind === 'fs_edit' || event.kind === 'fs_write' || event.kind === 'file_edit') && event.path) {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders?.length) {
                        const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, event.path);
                        vscode.commands.executeCommand('vscode.open', fileUri, { preview: true });
                    }
                }

                if (event.kind === 'status' && event.summary.includes('complete')) {
                    ReviewPanel.show(context.extensionUri, client!, runId);
                }
            });

            await client!.connect(runId);
            statusBar?.update('running');

            cancel.onCancellationRequested(() => client?.disconnect());
        }
    );
}

export function deactivate() {
    client?.disconnect();
    statusBar?.dispose();
}
